import fs from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
/**
 * Only mandatory external-BIOS systems are gated. Folder components, accepted filename groups,
 * and byte sizes are diagnostic rules, not cryptographic validation.
 */
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
/**
 * Resolve only a BIOS-gated platform into its system subdirectory; reject unsupported upload
 * targets.
 *
 * @param {string} retroarchDir - Active writable RetroArch runtime directory shared by install, status, and launch.
 * @param {string} system - Console ID from the shared platform registry.
 */
export const biosDirectory = (retroarchDir, system) => {
  if (!Object.hasOwn(BIOS_RULES, system))
    throw Error('This platform does not require a BIOS upload.')
  return join(retroarchDir, 'system', ...BIOS_RULES[system].folder)
}
/**
 * Inspect actual BIOS filenames and sizes, applying PS1 region selection. HLE platforms are
 * ready without a BIOS; this is not dump-content authentication.
 *
 * @param {string} retroarchDir - Active writable RetroArch runtime directory shared by install, status, and launch.
 * @param {string} system - Console ID from the shared platform registry.
 * @param {string} region - Optional detected game region, used for BIOS/artwork selection.
 * @param {string} platform - Platform selector; OS helpers accept win32/linux, BIOS and IPC helpers accept a library console ID.
 */
export function biosStatus(retroarchDir, system, region, platform = process.platform) {
  const rule = BIOS_RULES[system]
  if (!rule) return { required: false, ready: true, missing: [] }
  const directory = biosDirectory(retroarchDir, system)
  let files = []
  try {
    files = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        /**
         * Retain only fs .readdirSync(directory, { withFileTypes: true }) entries satisfying biosStatus's local predicate; excluded values do not reach the next stage.
         *
         * @param {*} f - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (f) => f.isFile()
      )
      .map(
        /**
         * Project each fs .readdirSync(directory, { withFileTypes: true }) .filter((f) => f.isFile()) entry for biosStatus; preserve input ordering in the derived collection.
         *
         * @param {*} f - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (f) => ({
          name: platform === 'win32' || system === 'PS2' ? f.name.toLowerCase() : f.name,
          size: fs.statSync(join(directory, f.name)).size
        })
      )
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
      /**
       * Retain only groups entries satisfying missing's local predicate; excluded values do not reach the next stage.
       *
       * @param {*} group - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (group) =>
        !files.some(
          /**
           * Short-circuit when any files entry meets missing's condition.
           *
           * @param {*} f - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (f) =>
            (group.includes(f.name) || (group.includes('*.bin') && f.name.endsWith('.bin'))) &&
            f.size > 0 &&
            (!rule.sizes || rule.sizes.includes(f.size))
        )
    )
    .map(
      /**
       * Project each groups .filter( (group) => !files.some( (f) => (group.includes(f.name) || (group.includes('*.bi entry for missing; preserve input ordering in the derived collection.
       *
       * @param {*} group - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (group) => group.join(' / ')
    )
  return { required: true, ready: !missing.length, missing, directory }
}

// Remove only the selected console's BIOS names, never the shared system directory.
/**
 * Resolve the real system path under RetroArch and unlink only this platform's matching BIOS
 * entries, preserving unrelated files.
 *
 * @param {string} retroarchDir - Active writable RetroArch runtime directory shared by install, status, and launch.
 * @param {string} system - Console ID from the shared platform registry.
 */
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
