import fs from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const CORE_FILES = {
  PS2: ['pcsx2_libretro.dll', 'lrps2_libretro.dll'],
  PS1: ['duckstation_libretro.dll', 'mednafen_psx_hw_libretro.dll', 'swanstation_libretro.dll'],
  PSP: ['ppsspp_libretro.dll'],
  NDS: ['melonds_libretro.dll'],
  N64: ['mupen64plus_next_libretro.dll'],
  GBA: ['mgba_libretro.dll'],
  GBC: ['gambatte_libretro.dll'],
  SNES: ['snes9x_libretro.dll'],
  NES: ['mesen_libretro.dll'],
  Genesis: ['genesis_plus_gx_libretro.dll'],
  GameCube: ['dolphin_libretro.dll'],
  Wii: ['dolphin_libretro.dll'],
  '3DS': ['citra_libretro.dll'],
  Dreamcast: ['flycast_libretro.dll'],
  'Atari 2600': ['stella_libretro.dll'],
  'Atari 7800': ['prosystem_libretro.dll'],
  'Atari Lynx': ['mednafen_lynx_libretro.dll']
}
export const coreFilesFor = (platform = process.platform) =>
  Object.fromEntries(
    Object.entries(CORE_FILES).map(([system, files]) => [
      system,
      files.map((file) => (platform === 'linux' ? file.replace(/\.dll$/, '.so') : file))
    ])
  )
export const buildbotBase = (platform) =>
  'https://buildbot.libretro.com/nightly/' +
  (platform === 'linux' ? 'linux' : 'windows') +
  '/x86_64/latest/'
const MAX = 200 * 1024 * 1024
export function extractCore(
  zip,
  expected,
  platform = expected.endsWith('.so') ? 'linux' : 'win32'
) {
  // Read the central directory, then inflate exactly the allowlisted DLL; never extract paths.
  let end = zip.length - 22
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) throw Error('Invalid ZIP archive')
  let offset = zip.readUInt32LE(end + 16)
  const count = zip.readUInt16LE(end + 10)
  let output
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw Error('Invalid ZIP directory')
    const flags = zip.readUInt16LE(offset + 8),
      method = zip.readUInt16LE(offset + 10)
    const crc = zip.readUInt32LE(offset + 16),
      compressed = zip.readUInt32LE(offset + 20),
      size = zip.readUInt32LE(offset + 24)
    const nameSize = zip.readUInt16LE(offset + 28),
      extra = zip.readUInt16LE(offset + 30),
      comment = zip.readUInt16LE(offset + 32)
    const name = zip.subarray(offset + 46, offset + 46 + nameSize).toString('utf8')
    if (name === expected) {
      if (output || flags & 1 || size > MAX || compressed > MAX || ![0, 8].includes(method))
        throw Error('Unsupported core archive')
      const local = zip.readUInt32LE(offset + 42)
      if (zip.readUInt32LE(local) !== 0x04034b50) throw Error('Invalid ZIP entry')
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      if (start + compressed > zip.length) throw Error('Truncated archive')
      const data = zip.subarray(start, start + compressed)
      output = method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: MAX })
      let actual = 0xffffffff
      for (const byte of output) {
        actual ^= byte
        for (let b = 0; b < 8; b++) actual = (actual >>> 1) ^ (actual & 1 ? 0xedb88320 : 0)
      }
      if (output.length !== size || (actual ^ 0xffffffff) >>> 0 !== crc)
        throw Error('Core checksum mismatch')
    }
    offset += 46 + nameSize + extra + comment
  }
  if (platform === 'linux') {
    if (
      !output ||
      output.length < 64 ||
      output.readUInt32BE(0) !== 0x7f454c46 ||
      output[4] !== 2 ||
      output[5] !== 1 ||
      output.readUInt16LE(16) !== 3 ||
      output.readUInt16LE(18) !== 62
    )
      throw Error('Core is not a Linux x64 shared object')
    return output
  }
  if (!output || output.length < 128 || output.toString('ascii', 0, 2) !== 'MZ')
    throw Error('Missing Windows core DLL')
  const pe = output.readUInt32LE(60)
  if (
    pe + 6 > output.length ||
    output.readUInt32LE(pe) !== 0x4550 ||
    output.readUInt16LE(pe + 4) !== 0x8664
  )
    throw Error('Core is not Windows x64')
  return output
}
export function createCoreManager({
  retroarchDir,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  arch = process.arch
}) {
  const coreFiles = coreFilesFor(platform)
  const pending = new Map()
  const find = (system) =>
    coreFiles[system]?.find((name) =>
      fs.statSync(join(retroarchDir, 'cores', name), { throwIfNoEntry: false })?.isFile()
    ) || null
  const installFiles = (files) => {
    const key = files.join(',')
    if (pending.has(key)) return pending.get(key)
    const task = (async () => {
      if (!['win32', 'linux'].includes(platform) || arch !== 'x64')
        return { success: false, error: 'Windows or Linux x64 is required for these cores.' }
      const existing = files.find((name) =>
        fs.statSync(join(retroarchDir, 'cores', name), { throwIfNoEntry: false })?.isFile()
      )
      if (existing) return { success: true, core: existing }
      let failure = 'Core is unavailable from the Libretro build server.'
      for (const name of files) {
        try {
          const response = await fetchImpl(`${buildbotBase(platform)}${name}.zip`, {
            signal: AbortSignal.timeout(120000),
            redirect: 'error'
          })
          if (response.status === 404) {
            await response.body?.cancel()
            continue
          }
          if (
            !response.ok ||
            !response.body ||
            Number(response.headers.get('content-length')) > MAX
          )
            throw Error('Core download failed or exceeds 200 MB.')
          const chunks = []
          let bytes = 0
          for await (const chunk of response.body) {
            bytes += chunk.length
            if (bytes > MAX) throw Error('Core download exceeds 200 MB.')
            chunks.push(Buffer.from(chunk))
          }
          const dll = extractCore(Buffer.concat(chunks), name, platform)
          const directory = join(retroarchDir, 'cores'),
            destination = join(directory, name)
          await fs.promises.mkdir(directory, { recursive: true })
          let ownsTemporary = false
          try {
            await fs.promises.writeFile(`${destination}.part`, dll, { flag: 'wx' })
            ownsTemporary = true
            await fs.promises.copyFile(
              `${destination}.part`,
              destination,
              fs.constants.COPYFILE_EXCL
            )
          } finally {
            if (ownsTemporary) await fs.promises.rm(`${destination}.part`, { force: true })
          }
          return { success: true, core: name }
        } catch (error) {
          failure = error.message
        }
      }
      return { success: false, error: failure }
    })().finally(() => pending.delete(key))
    pending.set(key, task)
    return task
  }
  const install = (system) =>
    Object.hasOwn(coreFiles, system)
      ? installFiles(coreFiles[system])
      : Promise.resolve({ success: false, error: 'Unsupported platform.' })
  // The IPC layer additionally requires membership in the catalog or an installed local core.
  const installNamed = (name) =>
    typeof name === 'string' &&
    /^[a-z0-9_-]+_libretro\.(dll|so)$/.test(name.toLowerCase()) &&
    name.endsWith(platform === 'linux' ? '.so' : '.dll')
      ? installFiles([name])
      : Promise.resolve({ success: false, error: 'Invalid core filename.' })
  return { find, install, installNamed }
}
