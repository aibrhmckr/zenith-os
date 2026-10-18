import { assertAllowedPath } from './securityBoundary.js'
import fs from 'node:fs/promises'
import { isAbsolute, resolve, dirname, extname, basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GAME_FILE_FILTERS, detectConsole } from '../../shared/consoles.js'
import { WALLPAPER_EXTENSIONS, validWallpaperHeader, MAX_WALLPAPER_BYTES } from './wallpapers.js'
import { previewMediaUrl } from './local-media.js'
import { createFolderSummary } from './folderSummary.js'

/** Read-only local browser. Import capabilities are short-lived, purpose-bound and revalidated. */
export function createFileBrowser({
  home,
  desktop,
  downloads,
  platform = process.platform,
  roots
} = {}) {
  const approvedRoots = [
    ...new Set((roots || [home, desktop, downloads]).filter(Boolean).map((root) => resolve(root)))
  ]
  const authorize = (path) => assertAllowedPath(path, approvedRoots)
  const tickets = new Map()
  const folders = new Map()
  const summaries = createFolderSummary()
  let summaryRevision = 0
  const directoryEntry = (path, name, stat, shortcut) => {
    const summaryToken = randomUUID()
    folders.set(summaryToken, { path, expires: Date.now() + 30 * 60 * 1000 })
    while (folders.size > 2000) folders.delete(folders.keys().next().value)
    return {
      name,
      path,
      directory: true,
      modified: stat.mtimeMs,
      summaryToken,
      ...(shortcut ? { shortcut } : {})
    }
  }
  let preview = null,
    previewRevision = 0
  const clearPreview = () => {
    previewRevision++
    preview?.revoke()
    preview = null
  }
  const validate = async (token, kind) => {
    const ticket = tickets.get(token)
    if (!ticket || (kind && ticket.kind !== kind) || ticket.expires < Date.now())
      throw Error('File selection expired. Select it again.')
    authorize(ticket.path)
    const stat = await fs.lstat(ticket.path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== ticket.size ||
      stat.mtimeMs !== ticket.mtimeMs
    )
      throw Error('Selected file changed. Select it again.')
    return ticket
  }
  const extensions = (kind) => {
    if (kind === 'games') return GAME_FILE_FILTERS[0].extensions
    if (kind === 'wallpaper') return WALLPAPER_EXTENSIONS
    if (kind === 'package') return ['pkg']
    if (kind === 'firmware') return ['pup']
    throw Error('Invalid browser purpose.')
  }
  const localPath = (value) => {
    if (
      typeof value !== 'string' ||
      !isAbsolute(value) ||
      value.includes('\0') ||
      (platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')))
    )
      throw Error('Select a local directory.')
    return authorize(value)
  }
  const directories = async () => {
    const values = [...new Set([home, desktop, downloads, ...approvedRoots].filter(Boolean))]
    return (
      await Promise.all(
        values.map(async (path) => {
          try {
            authorize(path)
          } catch {
            return null
          }
          const stat = await fs.lstat(path).catch(() => null)
          return stat?.isDirectory() && !stat.isSymbolicLink()
            ? directoryEntry(
                path,
                path,
                stat,
                path === home
                  ? 'home'
                  : path === desktop
                    ? 'desktop'
                    : path === downloads
                      ? 'downloads'
                      : 'drive'
              )
            : null
        })
      )
    ).filter(Boolean)
  }
  return {
    /** Only recently listed folders can be summarized; null cancels superseded navigation work. */
    async folderSummary(token) {
      const generation = ++summaryRevision
      summaries.cancel()
      if (token === null) return { canceled: true }
      const ticket = folders.get(token)
      if (!ticket || ticket.expires < Date.now())
        throw Error('Folder selection expired. Select it again.')
      authorize(ticket.path)
      const stat = await fs.lstat(ticket.path)
      if (generation !== summaryRevision) return { canceled: true }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Folder is unavailable.')
      return summaries.scan(ticket.path)
    },
    /** Register only a validated raster/video selection; replace/revoke the previous preview. */
    async preview(token) {
      clearPreview()
      if (token === null) return { url: null }
      const revision = previewRevision
      const ticket = await validate(token)
      const extension = extname(ticket.path).toLowerCase()
      if (!WALLPAPER_EXTENSIONS.includes(extension.slice(1))) return { url: null }
      if (!ticket.size || ticket.size > MAX_WALLPAPER_BYTES)
        throw Error('Preview file is too large or empty.')
      const handle = await fs.open(ticket.path, 'r')
      try {
        const header = Buffer.alloc(16)
        await handle.read(header, 0, 16, 0)
        if (!validWallpaperHeader(header, extension)) throw Error('Preview format is invalid.')
      } finally {
        await handle.close()
      }
      if (revision !== previewRevision) return { url: null }
      preview = previewMediaUrl(ticket.path)
      return { url: preview.url }
    },
    async list({ kind, path = null, offset = 0 } = {}) {
      const allowed = extensions(kind)
      if (!Number.isInteger(offset) || offset < 0) throw Error('Invalid page.')
      if (path === null) return { path: null, parent: null, entries: await directories() }
      path = localPath(path)
      const stat = await fs.lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Folder is unavailable.')
      const entries = (await fs.readdir(path, { withFileTypes: true }))
        .filter(
          (entry) =>
            !entry.isSymbolicLink() &&
            (entry.isDirectory() ||
              (entry.isFile() && allowed.includes(extname(entry.name).slice(1).toLowerCase())))
        )
        .sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) ||
            a.name.localeCompare(b.name, undefined, { numeric: true })
        )
      for (const [id, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(id)
      const page = await Promise.all(
        entries.slice(offset, offset + 250).map(async (entry) => {
          const file = join(path, entry.name)
          const info = await fs.lstat(file).catch(() => null)
          if (entry.isDirectory())
            return info?.isDirectory() && !info.isSymbolicLink()
              ? directoryEntry(file, entry.name, info)
              : null
          if (!info?.isFile() || info.isSymbolicLink()) return null
          const token = randomUUID()
          tickets.set(token, {
            path: file,
            kind,
            size: info.size,
            mtimeMs: info.mtimeMs,
            expires: Date.now() + 30 * 60 * 1000
          })
          while (tickets.size > 10000) tickets.delete(tickets.keys().next().value)
          const extension = extname(file).toLowerCase()
          const type = ['.png', '.jpg', '.webp'].includes(extension)
            ? 'image'
            : ['.mp4', '.webm'].includes(extension)
              ? 'video'
              : 'game'
          // Ambiguous ISO defaults are not evidence of an inspected disc's platform.
          const detected = detectConsole(file)
          const system =
            detected === 'Unassigned' || (extension === '.iso' && detected === 'PS2')
              ? null
              : detected
          return {
            name: basename(file),
            token,
            directory: false,
            size: info.size,
            modified: info.mtimeMs,
            type,
            platform: system || null
          }
        })
      )
      return {
        path,
        parent: approvedRoots.includes(path) ? null : dirname(path),
        breadcrumbs: (() => {
          const result = []
          for (let current = path; ; current = dirname(current)) {
            result.unshift({ name: basename(current) || current, path: current })
            if (approvedRoots.includes(current) || dirname(current) === current) return result
          }
        })(),
        entries: page.filter(Boolean),
        previousOffset: offset > 0 ? Math.max(0, offset - 250) : null,
        nextOffset: offset + 250 < entries.length ? offset + 250 : null
      }
    },
    async consume(kind, tokens) {
      extensions(kind)
      if (
        !Array.isArray(tokens) ||
        !tokens.length ||
        tokens.length > 100 ||
        new Set(tokens).size !== tokens.length
      )
        throw Error('Select files in the file browser.')
      const selected = await Promise.all(
        tokens.map(async (token) => {
          const ticket = await validate(token, kind)
          return ticket.path
        })
      )
      tokens.forEach((token) => tickets.delete(token))
      return selected
    }
  }
}
