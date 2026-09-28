import path from 'node:path'

export function pathKey(file, platform = process.platform) {
  const normalized = path.normalize(file)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

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
  const retroarchDir = paths.join(root, 'emulators', 'retroarch')
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
