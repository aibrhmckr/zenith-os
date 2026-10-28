import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BUILTIN_WALLPAPERS, DEFAULT_WALLPAPER } from '../../shared/wallpapers.js'
import { mediaUrl, revokeMediaFile } from './local-media.js'

export const WALLPAPER_EXTENSIONS = ['png', 'jpg', 'webp', 'mp4', 'webm']
export const MAX_WALLPAPER_BYTES = 200 * 1024 * 1024
const filenamePattern = /^[a-f0-9-]{36}\.(png|jpg|webp|mp4|webm)$/

/** Bounded signature check rejects renamed executables, HTML and unsupported formats. */
export function validWallpaperHeader(bytes, extension) {
  if (extension === '.png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (extension === '.jpg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (extension === '.webp')
    return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (extension === '.mp4') return bytes.toString('ascii', 4, 8) === 'ftyp'
  if (extension === '.webm') return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
  return false
}

/** Main resolves browser tokens to import paths. Renderer selects registered IDs, never write paths. */
export function createWallpaperManager({ userData, preferences, urlFor = mediaUrl }) {
  const directory = join(userData, 'wallpapers')
  const ownedDirectory = async () => {
    await fs.mkdir(directory, { recursive: true })
    if ((await fs.lstat(directory)).isSymbolicLink())
      throw Error('Wallpaper directory cannot be a link.')
  }
  const list = async () => {
    await ownedDirectory()
    const saved = preferences.get().wallpapers || {}
    const items = [...BUILTIN_WALLPAPERS]
    for (const item of Array.isArray(saved.items) ? saved.items : []) {
      if (!item || !filenamePattern.test(item.fileName) || item.id !== item.fileName) continue
      const file = join(directory, item.fileName)
      const stat = await fs.lstat(file).catch(() => null)
      if (!stat?.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > MAX_WALLPAPER_BYTES)
        continue
      items.push({
        id: item.id,
        name: String(item.name || 'Wallpaper'),
        type: /\.(mp4|webm)$/.test(item.fileName) ? 'video' : 'image',
        url: urlFor(file)
      })
    }
    return {
      selectedId: items.some((item) => item.id === saved.selectedId)
        ? saved.selectedId
        : DEFAULT_WALLPAPER,
      onlyCustom: saved.onlyCustom === true,
      items
    }
  }
  const update = async (patch) => {
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.entries(patch).some(
        ([key, value]) =>
          !['selectedId', 'onlyCustom'].includes(key) ||
          (key === 'onlyCustom' ? typeof value !== 'boolean' : typeof value !== 'string')
      )
    )
      throw Error('Invalid wallpaper preference.')
    const state = await list()
    if (patch.selectedId !== undefined && !state.items.some((item) => item.id === patch.selectedId))
      throw Error('Wallpaper is unavailable.')
    await preferences.update((current) => ({ wallpapers: { ...current.wallpapers, ...patch } }))
    return { ...state, ...patch }
  }
  const importFile = async (source) => {
    await ownedDirectory()
    const extension = extname(source).toLowerCase()
    if (!WALLPAPER_EXTENSIONS.includes(extension.slice(1)))
      throw Error('Unsupported wallpaper format.')
    const sourceStat = await fs.lstat(source)
    if (
      !sourceStat.isFile() ||
      sourceStat.isSymbolicLink() ||
      !sourceStat.size ||
      sourceStat.size > MAX_WALLPAPER_BYTES
    )
      throw Error('Select a regular wallpaper file up to 200 MB.')
    const fileName = randomUUID() + extension
    const destination = join(directory, fileName),
      temporary = destination + '.part'
    try {
      await fs.copyFile(source, temporary, constants.COPYFILE_EXCL)
      const file = await fs.open(temporary, 'r')
      try {
        const stat = await file.stat(),
          header = Buffer.alloc(32)
        await file.read(header, 0, header.length, 0)
        if (stat.size !== sourceStat.size || !validWallpaperHeader(header, extension))
          throw Error('Invalid or incomplete wallpaper file.')
      } finally {
        await file.close()
      }
      await fs.rename(temporary, destination)
      await preferences.update((current) => ({
        wallpapers: {
          ...current.wallpapers,
          items: [
            ...(Array.isArray(current.wallpapers?.items) ? current.wallpapers.items : []),
            { id: fileName, fileName, name: basename(source) }
          ]
        }
      }))
      return list()
    } catch (error) {
      await fs.rm(destination, { force: true })
      throw error
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
  /** Delete only manifest-owned regular files; never recursively delete a renderer-supplied path. */
  const remove = async (options) => {
    if (
      !options ||
      options.confirmed !== true ||
      (options.all !== true && typeof options.id !== 'string' && !Array.isArray(options.ids))
    )
      throw Error('Wallpaper deletion requires confirmation.')
    await ownedDirectory()
    const saved = preferences.get().wallpapers || {}
    const items = Array.isArray(saved.items) ? saved.items : []
    const ids = options.ids === undefined ? [options.id] : options.ids
    if (
      options.ids !== undefined &&
      (options.all === true ||
        options.id !== undefined ||
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 10000 ||
        ids.some((id) => typeof id !== 'string' || !filenamePattern.test(id)))
    )
      throw Error('Invalid wallpaper selection.')
    const selected = new Set(ids)
    const targets = items.filter(
      (item) =>
        item &&
        filenamePattern.test(item.fileName) &&
        item.id === item.fileName &&
        (options.all === true || selected.has(item.id))
    )
    // Validate the entire selection before unlinking anything: a mixed forged/valid list is atomic.
    if (!options.all && (targets.length !== selected.size || !targets.length))
      throw Error('Unknown wallpaper.')
    const removed = new Set()
    let failure
    for (const item of targets) {
      const file = join(directory, item.fileName)
      try {
        const stat = await fs.lstat(file).catch((error) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (stat && (!stat.isFile() || stat.isSymbolicLink()))
          throw Error('Wallpaper is not a regular file.')
        if (stat) await fs.unlink(file)
        revokeMediaFile(file)
        removed.add(item.id)
      } catch (error) {
        failure = error
      }
    }
    // Persist successful removals even when one locked file cannot be deleted.
    await preferences.update((current) => ({
      wallpapers: {
        ...current.wallpapers,
        items: (current.wallpapers?.items || []).filter((item) => !removed.has(item.id)),
        selectedId: removed.has(current.wallpapers?.selectedId)
          ? DEFAULT_WALLPAPER
          : current.wallpapers?.selectedId
      }
    }))
    if (failure) throw failure
    return list()
  }
  // Imports, selections and deletes share one queue so a slow copy cannot resurrect a deleted item.
  let pending = Promise.resolve()
  const serialize =
    (operation) =>
    (...args) => {
      const next = pending.then(() => operation(...args))
      pending = next.catch(() => {})
      return next
    }
  return {
    list,
    update: serialize(update),
    importFile: serialize(importFile),
    remove: serialize(remove)
  }
}
