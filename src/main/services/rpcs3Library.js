import fs from 'node:fs'
import { join, resolve, relative, sep, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { isPS3BootPath } from '../../shared/consoles.js'
import { pathKey } from './platform.js'

const MAX_SFO = 1024 * 1024

/** Read PARAM.SFO's bounded little-endian index tables; reject invalid offsets and duplicate keys. */
export function readParamSfo(bytes) {
  if (
    bytes.length < 20 ||
    bytes.length > MAX_SFO ||
    bytes.readUInt32LE(0) !== 0x46535000 ||
    bytes.readUInt32LE(4) !== 0x101
  )
    throw Error('Invalid PARAM.SFO header.')
  const keys = bytes.readUInt32LE(8),
    data = bytes.readUInt32LE(12),
    count = bytes.readUInt32LE(16)
  if (count > 1024 || keys < 20 + count * 16 || data < keys || data > bytes.length)
    throw Error('Invalid PARAM.SFO tables.')
  const result = Object.create(null)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let i = 0; i < count; i++) {
    const offset = 20 + i * 16
    const keyStart = keys + bytes.readUInt16LE(offset),
      format = bytes.readUInt16LE(offset + 2)
    const length = bytes.readUInt32LE(offset + 4),
      capacity = bytes.readUInt32LE(offset + 8)
    const start = data + bytes.readUInt32LE(offset + 12)
    const keyEnd = bytes.indexOf(0, keyStart)
    if (
      keyStart >= data ||
      keyEnd < keyStart ||
      keyEnd >= data ||
      length > capacity ||
      start + capacity > bytes.length
    )
      throw Error('Invalid PARAM.SFO entry.')
    const key = bytes.toString('ascii', keyStart, keyEnd)
    if (Object.hasOwn(result, key)) throw Error('Duplicate PARAM.SFO key.')
    result[key] =
      format === 0x204 ? decoder.decode(bytes.subarray(start, start + length)).split('\0')[0] : null
  }
  return result
}

/** Ownership is lexical first; the scanner also rejects links at every existing path segment. */
export function isRpcs3ManagedPath(runtime, file) {
  const rel = relative(resolve(runtime.directory), resolve(file))
  return rel !== '..' && !rel.startsWith('..' + sep) && !/^[A-Za-z]:|^[/\\]/.test(rel)
}

function ownedStat(runtime, file) {
  if (!isRpcs3ManagedPath(runtime, file)) throw Error('External RPCS3 VFS is not scanned.')
  let current = resolve(runtime.directory),
    stat = fs.lstatSync(current)
  if (stat.isSymbolicLink()) throw Error('Linked RPCS3 runtime.')
  for (const part of relative(current, file).split(sep).filter(Boolean)) {
    current = join(current, part)
    stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw Error('Linked RPCS3 content.')
  }
  return stat
}

/**
 * Discover installed PS3 boot targets under the runtime's dev_hdd0/game VFS mapping.
 * No recursive search or copying EBOOT alone: the complete installed tree stays with RPCS3.
 * One malformed/incomplete title is skipped without hiding other games. Recheck on every scan.
 */
export function scanRpcs3Games(runtime) {
  let directory, entries
  try {
    directory = join(runtime.dataDirectory('dev_hdd0'), 'game')
    if (!ownedStat(runtime, directory).isDirectory()) return []
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const games = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Z]{4}\d{5}$/.test(entry.name)) continue
    try {
      const titleDirectory = join(directory, entry.name)
      const file = join(titleDirectory, 'PARAM.SFO'),
        boot = join(titleDirectory, 'USRDIR', 'EBOOT.BIN')
      const stat = ownedStat(runtime, file),
        executable = ownedStat(runtime, boot)
      if (!stat.isFile() || stat.size > MAX_SFO || !executable.isFile() || executable.size === 0)
        continue
      const fd = fs.openSync(file, 'r')
      let metadata
      try {
        const bytes = Buffer.alloc(MAX_SFO + 1)
        const size = fs.readSync(fd, bytes, 0, bytes.length, 0)
        metadata = readParamSfo(bytes.subarray(0, size))
      } finally {
        fs.closeSync(fd)
      }
      // GD is game data/updates, not a standalone digital title, even when it includes an EBOOT.
      if (metadata.TITLE_ID !== entry.name || !['HG', 'DG'].includes(metadata.CATEGORY)) continue
      const title = metadata.TITLE?.replace(/\s+/g, ' ').trim() || entry.name
      const importKey = createHash('sha256').update(pathKey(boot)).digest('hex').slice(0, 16)
      const embedded = readPs3EmbeddedMedia({ systemShort: 'PS3', path: boot })
      games.push({
        id: `rpcs3-${entry.name}`,
        titleId: entry.name,
        title,
        fileName: 'EBOOT.BIN',
        path: boot,
        system: 'PS3',
        systemShort: 'PS3',
        importKey,
        rpcs3Installed: true,
        cover: embedded.boxart,
        backdrop: embedded.snap || embedded.boxart
      })
    } catch {
      /* Missing, locked or malformed title; retry on a later scan. */
    }
  }
  return games.sort((a, b) => a.title.localeCompare(b.title))
}

/**
 * Probe only the known PS3 content directory beside USRDIR/EBOOT.BIN. No ISO unpacking,
 * network requests or writes: local art is usable on the first library read. PIC0 is optional
 * transparent overlay artwork, not guaranteed to be a logo. Invalid/linked images are ignored.
 */
export function readPs3EmbeddedMedia(game) {
  const result = { boxart: null, snap: null, logo: null }
  if (game.systemShort !== 'PS3' || typeof game.path !== 'string' || !isPS3BootPath(game.path))
    return result
  const root = dirname(dirname(resolve(game.path)))
  const runtime = { directory: root }
  try {
    if (!ownedStat(runtime, game.path).isFile()) return result
  } catch {
    return result
  }
  for (const [kind, name] of Object.entries({
    boxart: 'ICON0.PNG',
    snap: 'PIC1.PNG',
    logo: 'PIC0.PNG'
  })) {
    let fd
    try {
      const file = join(root, name)
      const stat = ownedStat(runtime, file)
      if (!stat.isFile() || stat.size < 24 || stat.size > 20 * 1024 * 1024) continue
      fd = fs.openSync(file, 'r')
      const header = Buffer.alloc(24)
      if (
        fs.readSync(fd, header, 0, 24, 0) !== 24 ||
        !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        header.toString('ascii', 12, 16) !== 'IHDR' ||
        header.readUInt32BE(16) === 0 ||
        header.readUInt32BE(20) === 0
      )
        continue
      result[kind] = file
    } catch {
      /* Optional artwork may be missing, locked or malformed. */
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  return result
}

/** Resolve display/search metadata for an already registered PS3 folder boot path. */
export function readPs3FolderTitle(game) {
  if (game.systemShort !== 'PS3' || typeof game.path !== 'string' || !isPS3BootPath(game.path))
    return null
  const root = dirname(dirname(resolve(game.path)))
  const file = join(root, 'PARAM.SFO')
  try {
    const stat = ownedStat({ directory: root }, file)
    if (!stat.isFile() || stat.size > MAX_SFO) return null
    const metadata = readParamSfo(fs.readFileSync(file))
    return metadata.TITLE?.replace(/\s+/g, ' ').trim() || null
  } catch {
    return null
  }
}

/** Resolve the disc/product ID for registered folder games without trusting their display title. */
export function readPs3FolderTitleId(game) {
  if (game.systemShort !== 'PS3' || !isPS3BootPath(game.path || '')) return null
  const root = dirname(dirname(resolve(game.path))),
    file = join(root, 'PARAM.SFO')
  try {
    const stat = ownedStat({ directory: root }, file)
    if (!stat.isFile() || stat.size > MAX_SFO) return null
    const value = readParamSfo(fs.readFileSync(file))
      .TITLE_ID?.replace(/[-\s\0]/g, '')
      .toUpperCase()
    return /^[A-Z]{4}[0-9]{5}$/.test(value) ? value : null
  } catch {
    return null
  }
}
