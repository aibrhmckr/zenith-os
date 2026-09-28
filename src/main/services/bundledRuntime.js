import fs from 'node:fs/promises'
import path from 'node:path'

export async function seedBundledRetroArch({
  resourcesPath,
  retroarchDir,
  platform = process.platform
}) {
  const name = platform === 'win32' ? 'retroarch.exe' : 'retroarch'
  const executable = path.join(retroarchDir, name)
  try {
    await fs.access(executable)
    return false // Preserve user upgrades, installed cores and BIOS.
  } catch {
    /* first packaged launch */
  }
  const source = path.join(resourcesPath, 'emulators', 'retroarch')
  await fs.access(path.join(source, name))
  await fs.mkdir(retroarchDir, { recursive: true })
  await fs.cp(source, retroarchDir, {
    recursive: true,
    force: false,
    filter: (file) => file !== path.join(source, name)
  })
  const temporary = executable + '.seed-part'
  await fs.copyFile(path.join(source, name), temporary)
  if (platform === 'linux') await fs.chmod(temporary, 0o755)
  await fs.rename(temporary, executable)
  return true
}
