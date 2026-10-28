import fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inflateRawSync, crc32 } from 'node:zlib'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'

/**
 * Ordered default libretro core candidates by console; coreFilesFor derives native host
 * extensions.
 */
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
/**
 * Derive ordered platform core candidates with host-native extensions; Linux uses SO files
 * instead of Windows DLLs.
 *
 * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 */
export const coreFilesFor = (platform = process.platform) =>
  Object.fromEntries(
    Object.entries(CORE_FILES).map(
      /**
       * Project each Object.entries(CORE_FILES) entry for coreFilesFor; preserve input ordering in the derived collection.
       *
       * @param {*} input1 - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      ([system, files]) => [
        system,
        files.map(
          /**
           * Project each files entry for coreFilesFor; preserve input ordering in the derived collection.
           *
           * @param {*} file - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (file) => (platform === 'linux' ? file.replace(/\.dll$/, '.so') : file)
        )
      ]
    )
  )
/**
 * Select the official Windows/Linux x64 nightly directory; installation separately rejects
 * unsupported hosts and architectures.
 *
 * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 */
export const buildbotBase = (platform) =>
  'https://buildbot.libretro.com/nightly/' +
  (platform === 'linux' ? 'linux' : 'windows') +
  '/x86_64/latest/'
/**
 * 200-MiB archive, unpacked payload, and installed-file size ceiling.
 */
const MAX = 200 * 1024 * 1024
export const CORE_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** A cooldown applies only to the same physically verified file after a successful installation. */
function recentlyUpdated(destination, now) {
  try {
    const record = JSON.parse(fs.readFileSync(destination + '.zenith-update.json', 'utf8'))
    const stat = fs.statSync(destination)
    const age = now - record.checkedAt
    return (
      age >= 0 &&
      age < CORE_UPDATE_INTERVAL_MS &&
      record.size === stat.size &&
      record.mtimeMs === stat.mtimeMs
    )
  } catch {
    return false
  }
}
// One physical-file check for the installer, catalog, status IPC and launcher.
/**
 * Return the absolute path only for a readable, nonempty native x64 core with valid PE/ELF
 * headers. All status, catalog, and launch paths share this physical check.
 *
 * @param {string} retroarchDir - Active writable RetroArch runtime directory shared by install, status, and launch.
 * @param {string} name - Filename or named action selected by the caller; accepted values are validated by this helper.
 * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 */
export function installedCorePath(retroarchDir, name, platform = process.platform) {
  if (
    typeof name !== 'string' ||
    !/^[a-z0-9_-]+_libretro\.(dll|so)$/i.test(name) ||
    !name.endsWith(platform === 'linux' ? '.so' : '.dll')
  )
    return null
  /**
   * Absolute target under the active runtime cores directory; never use packaged read-only
   * resources.
   */
  const destination = resolve(retroarchDir, 'cores', name)
  let fd
  try {
    if (!fs.existsSync(destination)) return null
    fd = fs.openSync(destination, 'r')
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size < 128 || stat.size > MAX) return null
    const header = Buffer.alloc(64)
    if (fs.readSync(fd, header, 0, 64, 0) !== 64) return null
    if (platform === 'linux') {
      return header.readUInt32BE(0) === 0x7f454c46 &&
        header[4] === 2 &&
        header[5] === 1 &&
        header.readUInt16LE(16) === 3 &&
        header.readUInt16LE(18) === 62
        ? destination
        : null
    }
    if (header.toString('ascii', 0, 2) !== 'MZ') return null
    const offset = header.readUInt32LE(60),
      pe = Buffer.alloc(6)
    if (offset + 6 > stat.size || fs.readSync(fd, pe, 0, 6, offset) !== 6) return null
    return pe.readUInt32LE(0) === 0x4550 && pe.readUInt16LE(4) === 0x8664 ? destination : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
/**
 * Read a ZIP central directory and inflate only the exact requested basename. Enforce size, CRC,
 * compression, and host header checks without extracting archive paths.
 *
 * @param {Buffer} zip - Downloaded ZIP bytes to validate and inspect.
 * @param {string} expected - Exact core basename allowed in the ZIP archive.
 * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 */
export function extractCore(
  zip,
  expected,
  platform = expected.endsWith('.so') ? 'linux' : 'win32',
  inflate = inflateRawSync,
  checksum = crc32
) {
  const MAX = 200 * 1024 * 1024
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
      output = method === 0 ? Buffer.from(data) : inflate(data, { maxOutputLength: MAX })
      if (output.length !== size || checksum(output) !== crc) throw Error('Core checksum mismatch')
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
/** Inflate and validate off the Electron thread. Only trusted source and bytes enter this worker. */
export function extractCoreAsync(zip, expected, platform) {
  return new Promise((resolve, reject) => {
    const bytes = typeof zip === 'string' ? null : new Uint8Array(zip.length)
    if (bytes) bytes.set(zip)
    const source = `const { parentPort, workerData } = require('node:worker_threads');
      const zlib = require('node:zlib');
      try {
        const extract = (${extractCore.toString()});
        const output = extract(workerData.archive ? require('node:fs').readFileSync(workerData.archive) : Buffer.from(workerData.bytes), workerData.expected, workerData.platform, zlib.inflateRawSync, zlib.crc32);
        const result = new Uint8Array(output.length); result.set(output);
        parentPort.postMessage({ bytes: result }, [result.buffer]);
      } catch (error) { parentPort.postMessage({ error: error.message }); }`
    const worker = new Worker(source, {
      eval: true,
      workerData: { bytes, archive: typeof zip === 'string' ? zip : null, expected, platform },
      transferList: bytes ? [bytes.buffer] : []
    })
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => finish(Error('Core extraction timed out')), 120000)
    worker.once('message', (message) =>
      finish(
        message.error ? Error(message.error) : null,
        message.bytes && Buffer.from(message.bytes.buffer)
      )
    )
    worker.once('error', (error) => finish(error))
    worker.once('exit', () => {
      if (!settled) finish(Error('Core extraction worker stopped'))
    })
  })
}

/** Verify published bytes by streaming, avoiding a second full DLL allocation. */
async function fileDigest(file) {
  const hash = createHash('sha256')
  const handle = await fs.promises.open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    // Windows must release the DLL handle before verification failure can remove/replace it.
    await handle.close()
  }
  return hash.digest('hex')
}
/**
 * Bind physical verification and atomic core installation to one RetroArch directory, host, and
 * injectable fetch implementation.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.retroarchDir - Active writable RetroArch runtime directory shared by install, status, and launch.
 * @param {Function} options.fetchImpl - Injectable fetch implementation; defaults to global fetch and enables offline tests.
 * @param {string} options.platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 * @param {string} options.arch - Host CPU architecture; downloadable cores require x64.
 */
export function createCoreManager({
  retroarchDir,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  arch = process.arch,
  onProgress = () => {},
  now = Date.now
}) {
  /**
   * Host-specific candidate mapping shared by automatic lookup and installation.
   */
  const coreFiles = coreFilesFor(platform)
  /**
   * Map of ordered candidate-list keys to ongoing installation Promises.
   */
  const pending = new Map()
  /**
   * Resolve a core through the shared physical-file validator; return null rather than trusting a
   * cached installed flag.
   *
   * @param {string} name - Filename or named action selected by the caller; accepted values are validated by this helper.
   */
  const pathFor = (name) => installedCorePath(retroarchDir, name, platform)
  /**
   * Return the first physically valid core in a console's ordered fallback list, or null when
   * every candidate is absent/invalid.
   *
   * @param {string} system - Console ID from the shared platform registry.
   */
  const find = (system) =>
    coreFiles[system]?.find(
      /**
       * Select the first matching coreFiles[system] entry for find; absence is handled by the caller's fallback.
       *
       * @param {*} name - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (name) => pathFor(name)
    ) || null
  /**
   * Coalesce identical candidate lists, stream bounded official ZIP downloads, verify bytes,
   * publish atomically, and re-read the installed core. Return stage/source/target details on
   * failure.
   *
   * @param {string[]} files - Ordered fallback core filenames to try.
   */
  const installFiles = (files, update = false) => {
    const key = files.join(',')
    if (pending.has(key)) return pending.get(key)
    const task = (
      /**
       * Complete the enclosing callback step owned by task; caller arguments and captured state determine this stage's result.
       */
      async () => {
        if (!['win32', 'linux'].includes(platform) || arch !== 'x64')
          return { success: false, error: 'Windows or Linux x64 is required for these cores.' }
        const existing = files.find(
          /**
           * Select the first matching files entry for existing; absence is handled by the caller's fallback.
           *
           * @param {*} name - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (name) => pathFor(name)
        )
        if (existing && !update) return { success: true, core: existing }
        if (existing && update && recentlyUpdated(pathFor(existing), now()))
          return { success: true, core: existing, upToDate: true }
        let failure = 'Core is unavailable from the Libretro build server.'
        for (const name of files) {
          /**
           * Absolute target under the active runtime cores directory; never use packaged read-only
           * resources.
           */
          const destination = resolve(retroarchDir, 'cores', name)
          const url = `${buildbotBase(platform)}${name}.zip`
          /**
           * User-visible failure stage used to distinguish network, extraction, filesystem,
           * metadata-cleanup, and verification errors.
           */
          const report = (value) => onProgress({ id: 'core:' + name, name, ...value })
          let receipt
          if (update && pathFor(name)) {
            try {
              const saved = JSON.parse(
                await fs.promises.readFile(destination + '.zenith-update.json', 'utf8')
              )
              const stat = await fs.promises.stat(destination)
              if (saved.size === stat.size && saved.mtimeMs === stat.mtimeMs) receipt = saved
            } catch {
              /* Unverified legacy files are downloaded and validated again. */
            }
          }
          let stage = 'download'
          const archive = destination + '.' + randomUUID() + '.download-part'
          try {
            const response = await fetchImpl(url, {
              signal: AbortSignal.timeout(120000),
              headers: receipt?.etag
                ? { 'If-None-Match': receipt.etag }
                : receipt?.lastModified
                  ? { 'If-Modified-Since': receipt.lastModified }
                  : {},
              redirect: 'error'
            })
            if (response.status === 304 && receipt && pathFor(name)) {
              await response.body?.cancel()
              const temporary = destination + '.' + randomUUID() + '.receipt-part'
              try {
                await fs.promises.writeFile(
                  temporary,
                  JSON.stringify({ ...receipt, checkedAt: now() }),
                  { flag: 'wx' }
                )
                await fs.promises.rename(temporary, destination + '.zenith-update.json')
              } finally {
                await fs.promises.rm(temporary, { force: true })
              }
              return { success: true, core: name, upToDate: true }
            }
            report({ status: 'active', phase: 'downloading', received: 0, total: null })
            if (!response.ok) {
              await response.body?.cancel()
              throw Error(`HTTP ${response.status}`)
            }
            if (
              !response.ok ||
              !response.body ||
              Number(response.headers.get('content-length')) > MAX
            )
              throw Error('Core download failed or exceeds 200 MB.')
            await fs.promises.mkdir(dirname(destination), { recursive: true })
            const archiveFile = await fs.promises.open(archive, 'wx')
            let bytes = 0
            try {
              for await (const chunk of response.body) {
                bytes += chunk.length
                if (bytes > MAX) throw Error('Core download exceeds 200 MB.')
                await archiveFile.writeFile(chunk)
                report({
                  status: 'active',
                  received: bytes,
                  total: Number(response.headers.get('content-length')) || null
                })
              }
            } finally {
              await archiveFile.close()
            }
            report({ status: 'active', phase: 'verifying' })
            stage = 'extract'
            const dll = await extractCoreAsync(archive, name, platform)
            stage = 'write'
            await fs.promises.mkdir(dirname(destination), { recursive: true })
            /**
             * Unique exclusive staging path; publish only verified complete bytes and always clean up on
             * failure.
             */
            const temporary = `${destination}.${randomUUID()}.part`
            const backup = temporary + '.backup'
            const receiptTemporary = temporary + '.json'
            let backedUp = false
            let published = false
            let rollbackFailed = false
            try {
              // Fresh native Buffer writes do not propagate ZIP/browser attachment metadata.
              await fs.promises.writeFile(temporary, dll, { flag: 'wx' })
              if (platform === 'win32') {
                // Only this validated Buildbot download, never arbitrary existing local binaries.
                // Remove the named NTFS stream before publishing; no shell or system-policy edits.
                stage = 'Windows metadata cleanup'
                try {
                  await fs.promises.unlink(`${temporary}:Zone.Identifier`)
                } catch (error) {
                  if (error.code !== 'ENOENT') throw error
                }
              }
              stage = 'write'
              // Publish only a complete core, replacing broken/zero-byte previous installs.
              if (update && pathFor(name)) {
                await fs.promises.copyFile(destination, backup, fs.constants.COPYFILE_EXCL)
                backedUp = true
              }
              await fs.promises.rename(temporary, destination)
              published = true
              stage = 'verify'
              const written = await fileDigest(destination)
              if (written !== createHash('sha256').update(dll).digest('hex') || !pathFor(name)) {
                await fs.promises.rm(destination, { force: true })
                throw Error('Installed core is missing, unreadable or differs from the download.')
              }
              const stat = await fs.promises.stat(destination)
              await fs.promises.writeFile(
                receiptTemporary,
                JSON.stringify({
                  etag: response.headers.get('etag'),
                  lastModified: response.headers.get('last-modified'),
                  checkedAt: now(),
                  size: stat.size,
                  mtimeMs: stat.mtimeMs
                }),
                { flag: 'wx' }
              )
              await fs.promises.rename(receiptTemporary, destination + '.zenith-update.json')
            } catch (error) {
              if (backedUp && published) {
                try {
                  await fs.promises.rename(backup, destination)
                } catch (rollback) {
                  rollbackFailed = true
                  throw Error(
                    `${error.message} Recovery copy retained at ${backup}: ${rollback.message}`
                  )
                }
              }
              throw error
            } finally {
              await fs.promises.rm(temporary, { force: true })
              await fs.promises.rm(receiptTemporary, { force: true })
              // A failed rollback must leave its recovery copy intact.
              if (!rollbackFailed) await fs.promises.rm(backup, { force: true })
            }
            report({ status: 'completed', phase: 'ready' })
            return { success: true, core: name }
          } catch (error) {
            report({ status: 'failed', error: error.message })
            failure = `Core ${stage} failed (${error.code || error.message}). Source: ${url}. Target: ${destination}`
          } finally {
            await fs.promises.rm(archive, { force: true }).catch(() => {})
          }
        }
        return { success: false, error: failure }
      }
    )().finally(
      /**
       * Release task's pending-work bookkeeping after either success or failure.
       */
      () => pending.delete(key)
    )
    pending.set(key, task)
    return task
  }
  /**
   * Install a mapped console core with ordered fallbacks; unsupported platforms return a failed
   * Promise result.
   *
   * @param {string} system - Console ID from the shared platform registry.
   */
  const install = (system) =>
    Object.hasOwn(coreFiles, system)
      ? installFiles(coreFiles[system])
      : Promise.resolve({ success: false, error: 'Unsupported platform.' })
  // The IPC layer additionally requires membership in the catalog or an installed local core.
  /**
   * Validate a selected host-native basename before installation. The IPC caller must also
   * establish trusted catalog membership.
   *
   * @param {string} name - Filename or named action selected by the caller; accepted values are validated by this helper.
   */
  const installNamed = (name, update = false) =>
    typeof name === 'string' &&
    /^[a-z0-9_-]+_libretro\.(dll|so)$/.test(name.toLowerCase()) &&
    name.endsWith(platform === 'linux' ? '.so' : '.dll')
      ? installFiles([name], update)
      : Promise.resolve({ success: false, error: 'Invalid core filename.' })
  return {
    find,
    pathFor,
    install,
    installNamed,
    busy: () => pending.size > 0,
    whenIdle: () => Promise.allSettled([...pending.values()])
  }
}
