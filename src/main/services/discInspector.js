import fs from 'node:fs'
import { extname } from 'node:path'
import { detectConsole } from '../../shared/consoles.js'

const SECTOR = 2048
const cache = new Map()

/** Inspect bounded ISO9660 descriptors/root entries, never mount or extract a multi-GB disc. */
export function inspectIso(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const stat = fs.fstatSync(fd)
    const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    if (cache.get(file)?.stamp === stamp) return cache.get(file).platform
    const read = (offset, length) => {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        length > 1024 * 1024 ||
        offset + length > stat.size
      )
        return Buffer.alloc(0)
      const bytes = Buffer.alloc(length)
      return bytes.subarray(0, fs.readSync(fd, bytes, 0, length, offset))
    }
    const probe = () => {
      // PS3 disc system area and ISO9660 system identifier are bounded metadata, not payload searches.
      if (/^(?:PlayStation3|PS3)(?:\0|\s|$)/i.test(read(0x800, 32).toString('ascii'))) return 'PS3'
      for (let sector = 16; sector < 48; sector++) {
        const pvd = read(sector * SECTOR, SECTOR)
        if (pvd.length !== SECTOR || pvd.toString('ascii', 1, 6) !== 'CD001' || pvd[6] !== 1) break
        if (pvd[0] === 255) break
        if (pvd[0] !== 1) continue
        if (/^(PS3|PLAYSTATION[ _-]*3)(?:\s|\0|$)/i.test(pvd.toString('ascii', 8, 40).trim()))
          return 'PS3'
        if (pvd.readUInt16LE(128) !== SECTOR) continue
        const directory = read(pvd.readUInt32LE(158) * SECTOR, pvd.readUInt32LE(166))
        let config,
          psp = false
        for (let pos = 0; pos < directory.length;) {
          const length = directory[pos]
          if (!length) {
            pos = (Math.floor(pos / SECTOR) + 1) * SECTOR
            continue
          }
          if (length < 34 || pos + length > directory.length) break
          const nameLength = directory[pos + 32]
          if (33 + nameLength > length) break
          const name = directory
            .toString('ascii', pos + 33, pos + 33 + nameLength)
            .replace(/;\d+$/, '')
            .toUpperCase()
          const isDirectory = (directory[pos + 25] & 2) !== 0
          if (name === 'PS3_GAME' && isDirectory) return 'PS3'
          if (name === 'PSP_GAME' && isDirectory) psp = true
          if (name === 'SYSTEM.CNF' && !isDirectory)
            config = [directory.readUInt32LE(pos + 2) * SECTOR, directory.readUInt32LE(pos + 10)]
          pos += length
        }
        if (psp) return 'PSP'
        if (config && config[1] <= 64 * 1024) {
          const text = read(...config).toString('ascii')
          if (/^\s*BOOT2\s*=/im.test(text)) return 'PS2'
          if (/^\s*BOOT\s*=/im.test(text)) return 'PS1'
        }
      }
      return null
    }
    const platform = probe()
    if (cache.size >= 2048) cache.clear()
    cache.set(file, { stamp, platform })
    return platform
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Main-only classifier: explicit PS3 hints, physical disc evidence, known path hints, PS3 fallback. */
export function detectGamePlatform(file) {
  const hint = detectConsole(file)
  if (extname(file).toLowerCase() !== '.iso') return hint
  if (hint === 'PS3') return 'PS3'
  const disc = inspectIso(file)
  if (disc) return disc
  if (hint === 'PSP') return hint
  if (/(?:^|[^a-z0-9])(?:ps2|playstation[ _-]*2)(?:[^a-z0-9]|$)/i.test(file)) return 'PS2'
  return 'PS3'
}
