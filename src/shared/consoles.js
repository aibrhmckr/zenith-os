export const CONSOLE_EXTENSIONS = {
  // ISO defaults to PS2; the scanner overrides PSP hints in the file path.
  PS2: ['.iso', '.chd', '.gz'],
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
