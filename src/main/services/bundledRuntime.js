import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

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
  const optionalConfig = (relative) =>
    /\.cfg$/i.test(relative) || relative.split(path.sep)[0].toLowerCase() === 'autoconfig'
  const tolerateLock = (relative, error) => {
    if (!optionalConfig(relative) || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code))
      return false
    log(`[RetroArch setup] Skipped locked configuration ${relative}: ${error.code}`)
    return true
  }
  const existing = async (destination) => {
    try {
      return await fsImpl.lstat(destination)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return null
    }
  }
  const valid = (stat) =>
    stat &&
    (stat.isSymbolicLink() || (stat.isFile() && stat.size > 0 && Number.isFinite(stat.mtimeMs)))
  const copy = async (relative, symbolic = false) => {
    const destination = path.join(retroarchDir, relative)
    let temporary
    try {
      // Preserve newer binaries and user-edited configs, even if their size differs.
      const current = await existing(destination)
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
        await fsImpl.rm(temporary, { force: true }).catch((error) => {
          log(`[RetroArch setup] Could not remove temporary file ${temporary}: ${error.code}`)
        })
      }
    }
  }
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
  await walk()
  await copy(name)
  return copied
}
