import path from 'node:path'

/**
 * Normalize path separators and fold case on Windows only, preserving Linux filename identity.
 *
 * @param {string} file - Local file path, except ranking callbacks where it is an Archive file metadata entry.
 * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 */
export function pathKey(file, platform = process.platform) {
  const normalized = path.normalize(file)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Derive central games and emulator paths for development, portable Windows, and packaged hosts.
 * Packaged runtime writes go to userData rather than read-only resources.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 * @param {boolean} options.packaged - Whether paths are being resolved for an installed/portable build.
 * @param {string} options.appPath - Development application root.
 * @param {string} options.executable - Electron executable path used to resolve packaged Windows game storage.
 * @param {string} options.userData - Absolute Electron userData directory; owns caches and persistent runtime state.
 * @param {string} options.portableDirectory - Optional portable launcher directory override.
 */
export function runtimePaths({
  platform = process.platform,
  packaged = false,
  appPath,
  executable,
  userData,
  portableDirectory
}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  // AppImage mounts and /opt installations are read-only. Keep Linux runtime data writable.
  const root = !packaged
    ? appPath
    : platform === 'linux'
      ? userData
      : portableDirectory || paths.dirname(executable)
  // Installed resources can be read-only (Program Files, AppImage, /opt).
  // Seed a private writable runtime from process.resourcesPath on first launch.
  const retroarchDir = paths.join(packaged ? userData : root, 'emulators', 'retroarch')
  return {
    root,
    retroarchDir,
    gamesDirectory: paths.join(platform === 'linux' ? userData : root, 'games'),
    retroarchExecutable: paths.join(
      retroarchDir,
      platform === 'win32' ? 'retroarch.exe' : 'retroarch'
    )
  }
}
