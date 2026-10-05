import fs from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
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
      let cover = null
      try {
        const icon = join(titleDirectory, 'ICON0.PNG')
        if (ownedStat(runtime, icon).isFile()) cover = icon
      } catch {
        /* Optional local artwork. */
      }
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
        cover,
        backdrop: cover
      })
    } catch {
      /* Missing, locked or malformed title; retry on a later scan. */
    }
  }
  return games.sort((a, b) => a.title.localeCompare(b.title))
}
