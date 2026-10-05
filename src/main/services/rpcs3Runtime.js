import fs from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { load, JSON_SCHEMA } from 'js-yaml'
import { prepareRpcs3Config } from './rpcs3Config.js'
import { isPS3BootPath } from '../../shared/consoles.js'

/** Read only a bounded prefix; executable/firmware probes never load entire binaries. */
function prefix(file, length) {
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const count = fs.readSync(fd, buffer, 0, length, 0)
    return buffer.subarray(0, count)
  } finally {
    fs.closeSync(fd)
  }
}

/** A physical nonempty regular file is required; directories and broken links are not ready. */
function present(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/**
 * Main-owned standalone runtime. No renderer-supplied executable, download or firmware is trusted.
 * The portable/ directory takes precedence in RPCS3 on both Windows and Linux, so manual setup,
 * status probes and launches all share this configuration root rather than a global RPCS3 profile.
 * @param {{userData: string, platform?: string}} options - Electron userData and host OS.
 */
export function createRpcs3Runtime({ userData, platform = process.platform }) {
  const directory = resolve(userData, 'emulators', 'rpcs3')
  const executable = join(directory, platform === 'win32' ? 'rpcs3.exe' : 'rpcs3')
  const configDirectory = join(directory, 'portable')

  /** Create only the owned profile skeleton; never overwrite RPCS3 settings or install content. */
  function ensureDirectories() {
    fs.mkdirSync(configDirectory, { recursive: true })
  }

  /**
   * Resolve RPCS3's real VFS firmware mapping, including user-configured emulator/flash paths.
   * Windows stores vfs.yml in portable/config/, Linux in portable/. Invalid YAML is a visible
   * configuration failure, never a fallback that could report the wrong firmware as ready.
   */
  function dataDirectory(device = 'dev_flash') {
    if (!['dev_flash', 'dev_hdd0'].includes(device)) throw Error('Invalid RPCS3 device.')
    const file = join(configDirectory, ...(platform === 'win32' ? ['config'] : []), 'vfs.yml')
    let vfs = {}
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 64 * 1024) throw Error('RPCS3 vfs.yml is too large.')
      vfs = load(fs.readFileSync(file, 'utf8'), { schema: JSON_SCHEMA }) || {}
      if (typeof vfs !== 'object' || Array.isArray(vfs)) throw Error('Invalid RPCS3 vfs.yml.')
    }
    const emulator = vfs['$(EmulatorDir)'] || configDirectory
    const flash = vfs['/' + device + '/'] || '$(EmulatorDir)' + device + '/'
    if (typeof emulator !== 'string' || typeof flash !== 'string')
      throw Error('Invalid RPCS3 firmware directory mapping.')
    return resolve(
      directory,
      flash.replaceAll('$(EmulatorDir)', emulator.replace(/[\\/]+$/, '') + '/')
    )
  }

  /**
   * Recheck disk on every call. PE/ELF headers and installed firmware markers are structural
   * checks, not authenticity or complete firmware integrity verification. A PUP alone is not installed.
   */
  function status() {
    const result = {
      emulator: 'RPCS3',
      platform: 'PS3',
      directory,
      executable,
      configDirectory,
      executableReady: false,
      firmware: { ready: false, directory: join(configDirectory, 'dev_flash'), version: null },
      ready: false,
      error: null
    }
    try {
      if (!['win32', 'linux'].includes(platform)) {
        result.error = 'unsupported_rpcs3_host'
        return result
      }
      // Also makes manual launch from the opened folder use the identical portable profile.
      ensureDirectories()
      if (present(executable)) {
        const header = prefix(executable, 4096)
        if (platform === 'win32') {
          const pe = header.length >= 64 ? header.readUInt32LE(60) : -1
          result.executableReady =
            header.toString('ascii', 0, 2) === 'MZ' &&
            pe >= 64 &&
            pe + 6 <= header.length &&
            header.readUInt32LE(pe) === 0x4550 &&
            header.readUInt16LE(pe + 4) === 0x8664
        } else {
          result.executableReady =
            header.length >= 20 &&
            header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
            header[4] === 2 &&
            header[5] === 1 &&
            header.readUInt16LE(18) === 62
          fs.accessSync(executable, fs.constants.X_OK)
        }
      }
      result.firmware.directory = dataDirectory()
      const module = join(result.firmware.directory, 'sys', 'external', 'liblv2.sprx')
      const versionFile = join(result.firmware.directory, 'vsh', 'etc', 'version.txt')
      if (present(versionFile)) {
        result.firmware.version =
          prefix(versionFile, 4096)
            .toString('utf8')
            .match(/\brelease:(\d+\.\d+)/)?.[1] || null
      }
      result.firmware.ready =
        !!result.firmware.version &&
        present(module) &&
        prefix(module, 4).equals(Buffer.from([0x53, 0x43, 0x45, 0]))
      result.ready = result.executableReady && result.firmware.ready
      result.error = !result.executableReady
        ? 'missing_rpcs3'
        : !result.firmware.ready
          ? 'missing_ps3_firmware'
          : null
    } catch (error) {
      result.ready = false
      result.error = 'rpcs3_status_failed'
      result.message = error.message
    }
    return result
  }

  /**
   * Build a shell-free launch plan only after a fresh physical check. Caller must first authorize
   * gamePath against the library. PKG requires a separate installation workflow, never a boot attempt.
   * @param {string} gamePath - Absolute path of a recognized library ISO or intact USRDIR/EBOOT.BIN.
   */
  function prepareLaunch(gamePath) {
    if (typeof gamePath !== 'string' || !present(gamePath))
      return { success: false, error: 'ps3_game_missing', platform: 'PS3' }
    if (extname(gamePath).toLowerCase() === '.pkg')
      return { success: false, error: 'ps3_package_not_installed', platform: 'PS3' }
    if (extname(gamePath).toLowerCase() !== '.iso' && !isPS3BootPath(gamePath))
      return { success: false, error: 'ps3_invalid_game', platform: 'PS3' }
    const checked = status()
    if (!checked.ready)
      return { success: false, error: checked.error, platform: 'PS3', status: checked }
    try {
      prepareRpcs3Config({ configDirectory, platform })
    } catch (error) {
      return {
        success: false,
        error: 'rpcs3_config_failed',
        message: error.message,
        platform: 'PS3'
      }
    }
    const env = environment()
    return {
      success: true,
      env,
      executable,
      args: ['--no-gui', resolve(gamePath)],
      cwd: directory,
      label: 'RPCS3'
    }
  }

  /** Keep the same portable/cache environment for gameplay and installation. */
  function environment() {
    // Do not leak Zenith's AppImage identity into a separately installed RPCS3 process.
    const env = { ...process.env }
    if (platform === 'linux') {
      delete env.APPIMAGE
      delete env.APPDIR
      delete env.ARGV0
      env.XDG_CACHE_HOME = join(directory, 'cache')
    }
    return env
  }
  return {
    directory,
    configDirectory,
    executable,
    status,
    prepareLaunch,
    ensureDirectories,
    dataDirectory,
    environment
  }
}
