const fs = require('node:fs/promises')
const path = require('node:path')

// Fail packaging instead of silently shipping a launcher without its emulator.
module.exports = async ({ electronPlatformName, packager }) => {
  if (!['win32', 'linux'].includes(electronPlatformName)) {
    throw Error('Bundled RetroArch supports Windows and Linux only.')
  }
  const name = electronPlatformName === 'win32' ? 'retroarch.exe' : 'retroarch'
  const file = path.join(packager.projectDir, 'emulators', 'retroarch', name)
  let handle
  try {
    handle = await fs.open(file, 'r')
    const header = Buffer.alloc(4)
    await handle.read(header, 0, 4, 0)
    const valid =
      electronPlatformName === 'win32'
        ? header.subarray(0, 2).toString() === 'MZ'
        : header.equals(Buffer.from([127, 69, 76, 70]))
    if (!valid) throw Error('Wrong executable format.')
  } catch (error) {
    throw Error(
      `RetroArch missing or invalid for ${electronPlatformName}: ${file}. Run npm run setup:emulators on the target OS. ${error.message}`
    )
  } finally {
    await handle?.close()
  }
}
