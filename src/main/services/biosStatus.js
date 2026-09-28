import fs from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
export const BIOS_RULES = {
  PS2: {
    folder: ['pcsx2', 'bios'],
    groups: [['*.bin']],
    sizes: [4 * 1024 * 1024, 8 * 1024 * 1024]
  },
  PS1: {
    folder: [],
    groups: [['scph5500.bin', 'scph5501.bin', 'scph5502.bin', 'scph1001.bin']],
    sizes: [512 * 1024]
  },
  Dreamcast: { folder: ['dc'], groups: [['dc_boot.bin']], sizes: [2 * 1024 * 1024] }
}
export const biosDirectory = (retroarchDir, system) => {
  if (!Object.hasOwn(BIOS_RULES, system))
    throw Error('This platform does not require a BIOS upload.')
  return join(retroarchDir, 'system', ...BIOS_RULES[system].folder)
}
export function biosStatus(retroarchDir, system, region, platform = process.platform) {
  const rule = BIOS_RULES[system]
  if (!rule) return { required: false, ready: true, missing: [] }
  const directory = biosDirectory(retroarchDir, system)
  let files = []
  try {
    files = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => ({
        name: platform === 'win32' || system === 'PS2' ? f.name.toLowerCase() : f.name,
        size: fs.statSync(join(directory, f.name)).size
      }))
  } catch {
    /* absent */
  }
  const groups =
    system === 'PS1' && region
      ? [
          [
            region === 'Japan'
              ? 'scph5500.bin'
              : region === 'Europe'
                ? 'scph5502.bin'
                : 'scph5501.bin'
          ]
        ]
      : rule.groups
  const missing = groups
    .filter(
      (group) =>
        !files.some(
          (f) =>
            (group.includes(f.name) || (group.includes('*.bin') && f.name.endsWith('.bin'))) &&
            f.size > 0 &&
            (!rule.sizes || rule.sizes.includes(f.size))
        )
    )
    .map((group) => group.join(' / '))
  return { required: true, ready: !missing.length, missing, directory }
}

// Remove only the selected console's BIOS names, never the shared system directory.
export async function deleteBios(retroarchDir, system) {
  const directory = biosDirectory(retroarchDir, system)
  if (!fs.existsSync(directory)) return
  const root = fs.realpathSync(retroarchDir)
  const actual = fs.realpathSync(directory)
  const offset = relative(root, actual)
  if (!offset || offset.startsWith('..') || isAbsolute(offset))
    throw Error('BIOS directory is outside the emulator directory.')
  const names = BIOS_RULES[system].groups.flat()
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = entry.name.toLowerCase()
    if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      (names.includes(name) || (names.includes('*.bin') && name.endsWith('.bin')))
    ) {
      await fs.promises.unlink(join(actual, entry.name))
    }
  }
}
