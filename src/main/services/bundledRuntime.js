import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/**
 * Seed a writable userData RetroArch runtime asynchronously from packaged resources. Preserve
 * existing files, publish the executable last, and tolerate only optional configuration locks.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.resourcesPath - Packaged Electron resources directory containing the bundled RetroArch seed.
 * @param {string} options.retroarchDir - Active writable RetroArch runtime directory shared by install, status, and launch.
 * @param {string} options.platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 * @param {Object} options.fsImpl - Injectable filesystem promises implementation for deterministic startup/lock tests.
 * @param {Function} options.log - Logger for recoverable runtime-copy failures.
 */
export async function seedBundledRetroArch({
  resourcesPath,
  retroarchDir,
  platform = process.platform,
  fsImpl = fs,
  log = console.warn
}) {
  const name = platform === 'win32' ? 'retroarch.exe' : 'retroarch'
  const source = path.join(resourcesPath, 'emulators', 'retroarch')
  let copied = false
  let complete = true
  const critical = []
  const receiptPath = path.join(retroarchDir, '.zenith-seed.json')
  /**
   * Identify CFG/autoconfig entries whose lock may be skipped without blocking the whole runtime
   * preparation.
   *
   * @param {string} relative - Relative entry path within the bundled runtime tree.
   */
  const optionalConfig = (relative) =>
    /\.cfg$/i.test(relative) || relative.split(path.sep)[0].toLowerCase() === 'autoconfig'
  /**
   * Log recognized optional-file lock errors and report whether preparation may continue; required
   * runtime failures remain fatal to launch.
   *
   * @param {string} relative - Relative entry path within the bundled runtime tree.
   * @param {Error} error - Failure being classified or presented.
   */
  const tolerateLock = (relative, error) => {
    if (!optionalConfig(relative) || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code))
      return false
    complete = false
    log(`[RetroArch setup] Skipped locked configuration ${relative}: ${error.code}`)
    return true
  }
  /**
   * Read destination metadata without following symbolic links; distinguish a missing file from
   * permission and I/O errors.
   *
   * @param {string} destination - Resolved destination path.
   */
  const existing = async (destination) => {
    try {
      return await fsImpl.lstat(destination)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return null
    }
  }
  /**
   * Preserve a symlink or nonempty regular file with a finite timestamp, including user-modified
   * files of a different size.
   *
   * @param {Object} stat - Filesystem stat/lstat result, or null for a missing entry.
   */
  const valid = (stat) =>
    stat &&
    (stat.isSymbolicLink() || (stat.isFile() && stat.size > 0 && Number.isFinite(stat.mtimeMs)))
  /**
   * Copy one relative runtime entry via an exclusive temporary file and rename. Clean up staging
   * files and preserve a destination created concurrently.
   *
   * @param {string} relative - Relative entry path within the bundled runtime tree.
   * @param {boolean} symbolic - Whether the source entry is a symbolic link.
   */
  const copy = async (relative, symbolic = false) => {
    const destination = path.join(retroarchDir, relative)
    let temporary
    try {
      // Preserve newer binaries and user-edited configs, even if their size differs.
      const current = await existing(destination)
      if (relative === name || /\.(dll|so(?:\.[0-9.]+)?)$/i.test(relative)) critical.push(relative)
      if (valid(current)) return
      const file = path.join(source, relative)
      if (current?.isFile() && (await fsImpl.stat(file)).size === 0) return
      if (symbolic) {
        await fsImpl.cp(file, destination, { force: false, errorOnExist: true })
      } else {
        // Publish complete files only; interruption never leaves a partial target.
        temporary = destination + '.' + randomUUID() + '.seed-part'
        await fsImpl.copyFile(file, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
        if (platform === 'linux' && relative === name) await fsImpl.chmod(temporary, 0o755)
        if (valid(await existing(destination))) return
        await fsImpl.rename(temporary, destination)
      }
      copied = true
    } catch (error) {
      if (error.code !== 'EEXIST' && !tolerateLock(relative, error)) throw error
    } finally {
      if (temporary) {
        await fsImpl.rm(temporary, { force: true }).catch(
          /**
           * Handle the rejected stage of copy here so its failure follows this operation's fallback/error policy.
           *
           * @param {*} error - Failure from the preceding operation.
           */
          (error) => {
            log(`[RetroArch setup] Could not remove temporary file ${temporary}: ${error.code}`)
          }
        )
      }
    }
  }
  /**
   * Create and traverse runtime subdirectories, skipping the executable until all supporting
   * entries have been processed.
   *
   * @param {string} relative - Relative entry path within the bundled runtime tree.
   */
  const walk = async (relative = '') => {
    try {
      await fsImpl.mkdir(path.join(retroarchDir, relative), { recursive: true })
      for (const entry of await fsImpl.readdir(path.join(source, relative), {
        withFileTypes: true
      })) {
        const child = path.join(relative, entry.name)
        if (child === name) continue // Executable is published after supporting files.
        if (entry.isDirectory()) await walk(child)
        else await copy(child, entry.isSymbolicLink())
      }
    } catch (error) {
      if (!tolerateLock(relative, error)) throw error
    }
  }
  await fsImpl.access(path.join(source, name))
  const sourceStat = await fsImpl.stat(path.join(source, name))
  const identity = JSON.stringify({ source, size: sourceStat.size, mtime: sourceStat.mtimeMs })
  // Existing binaries may have been updated independently. Verify their physical presence,
  // but avoid enumerating thousands of unchanged autoconfig files on every application start.
  try {
    const receipt = JSON.parse(await fsImpl.readFile(receiptPath, 'utf8'))
    if (
      receipt.identity === identity &&
      Array.isArray(receipt.critical) &&
      receipt.critical.includes(name)
    ) {
      let ready = true
      for (const file of receipt.critical) {
        if (
          typeof file !== 'string' ||
          path.isAbsolute(file) ||
          file.split(/[\\/]/).includes('..') ||
          !valid(await existing(path.join(retroarchDir, file)))
        ) {
          ready = false
          break
        }
      }
      if (ready) return false
    }
  } catch {
    /* First run, changed bundle or missing dependency: repair incrementally. */
  }
  await walk()
  await copy(name)
  if (complete && fsImpl.writeFile) {
    const temporary = receiptPath + '.' + randomUUID() + '.tmp'
    try {
      await fsImpl.writeFile(temporary, JSON.stringify({ identity, critical }), { flag: 'wx' })
      await fsImpl.rename(temporary, receiptPath)
    } catch (error) {
      // This receipt is an optimization; successfully seeded binaries remain usable.
      log(`[RetroArch setup] Could not cache runtime receipt: ${error.code}`)
    } finally {
      await fsImpl.rm(temporary, { force: true }).catch(() => {})
    }
  }
  return copied
}
