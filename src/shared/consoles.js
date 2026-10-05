export const CONSOLE_EXTENSIONS = {
  // Shared extensions require detectConsole(); never infer ISO/BIN solely from this table.
  PS2: ['.iso', '.chd', '.gz'],
  PS3: ['.iso', '.pkg', '.bin'],
  PS1: ['.cue', '.pbp'],
  PSP: ['.cso'],
  NDS: ['.nds'],
  GBA: ['.gba'],
  GBC: ['.gb', '.gbc'],
  GameCube: ['.gcm', '.rvz'],
  Wii: ['.wbfs'],
  N64: ['.z64', '.n64', '.v64'],
  SNES: ['.sfc', '.smc'],
  NES: ['.nes'],
  '3DS': ['.3ds', '.cia'],
  Genesis: ['.md', '.gen', '.smd'],
  Dreamcast: ['.cdi', '.gdi'],
  'Atari 2600': ['.a26'],
  'Atari 7800': ['.a78'],
  'Atari Lynx': ['.lnx'],
  // A container or generic dump extension does not identify its emulated system.
  Unassigned: ['.bin', '.rom', '.atx', '.zip', '.7z']
}

/**
 * Relative PS3 boot layouts. BIN is a container extension, not a sufficient PS3 identifier.
 * A future folder importer must copy the entire game root, including PARAM.SFO and assets,
 * rather than flattening EBOOT.BIN into games/. These definitions perform no disk access.
 */
export const PS3_GAME_LAYOUTS = Object.freeze({
  disc: 'PS3_GAME/USRDIR/EBOOT.BIN',
  installed: 'USRDIR/EBOOT.BIN'
})

const extensionDefaults = new Map(
  Object.entries(CONSOLE_EXTENSIONS).flatMap(([platform, extensions]) =>
    extensions.map((extension) => [extension, platform])
  )
)
// Explicit defaults prevent registry ordering from changing existing libraries.
extensionDefaults.set('.iso', 'PS2')
extensionDefaults.set('.bin', 'Unassigned')

/** Recognize PS3 boot-path structure on either host; does not validate file contents/existence. */
export function isPS3BootPath(filePath) {
  if (typeof filePath !== 'string') return false
  const normalized = '/' + filePath.replaceAll('\\', '/').toLowerCase()
  return Object.values(PS3_GAME_LAYOUTS).some((layout) =>
    normalized.endsWith('/' + layout.toLowerCase())
  )
}

/**
 * Classify a library path without filesystem or Node dependencies (safe in Renderer).
 * ISO needs an explicit PS3/PlayStation 3 path token; retain PSP hints and PS2 fallback.
 * PKG is a PS3 installation candidate, not a claim that the package is bootable or valid.
 * @param {string} filePath - Original filename or full native path, before import flattens it.
 * @returns {string|undefined} Platform code, or undefined for an unsupported extension.
 */
export function detectConsole(filePath) {
  if (typeof filePath !== 'string') return undefined
  const normalized = filePath.replaceAll('\\', '/')
  const fileName = normalized.split('/').at(-1)
  const extension = fileName.match(/\.[^.]+$/)?.[0].toLowerCase()
  if (isPS3BootPath(normalized)) return 'PS3'
  if (extension === '.iso') {
    if (/(?:^|[^a-z0-9])(?:ps3|playstation[ _-]*3)(?:[^a-z0-9]|$)/i.test(normalized)) return 'PS3'
    if (/psp|vice city stories/i.test(normalized)) return 'PSP'
  }
  return extensionDefaults.get(extension)
}

// Keep the picker, central importer and scanner on the same extension allowlist.
export const GAME_FILE_FILTERS = [
  {
    name: 'Tüm Desteklenen Oyunlar',
    extensions: [
      ...new Set(
        Object.values(CONSOLE_EXTENSIONS)
          .flat()
          .map((ext) => ext.slice(1))
      )
    ]
  },
  { name: 'Tüm Dosyalar (*.*)', extensions: ['*'] }
]
