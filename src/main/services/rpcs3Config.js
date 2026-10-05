import fs from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { load, dump, JSON_SCHEMA } from 'js-yaml'

/** RPCS3's serialized values, not the human-facing settings dialog labels. */
const CACHE_SETTINGS = {
  Core: {
    'PPU Decoder': 'Recompiler (LLVM)',
    'LLVM Precompilation': true,
    'SPU Decoder': 'Recompiler (LLVM)',
    'SPU Cache': true
  },
  Video: {
    'Shader Mode': 'Async Recompiler (multi-threaded)',
    'Disable On-Disk Shader Cache': false
  }
}

/** Xbox mappings must replace keyboard bindings as well as the handler name. */
const XINPUT_MAPPING = {
  'Left Stick Left': 'LS X-',
  'Left Stick Right': 'LS X+',
  'Left Stick Up': 'LS Y+',
  'Left Stick Down': 'LS Y-',
  'Right Stick Left': 'RS X-',
  'Right Stick Right': 'RS X+',
  'Right Stick Up': 'RS Y+',
  'Right Stick Down': 'RS Y-',
  Start: 'Start',
  Select: 'Back',
  'PS Button': 'Guide',
  Square: 'X',
  Cross: 'A',
  Circle: 'B',
  Triangle: 'Y',
  Left: 'Left',
  Right: 'Right',
  Up: 'Up',
  Down: 'Down',
  R1: 'RB',
  R2: 'RT',
  R3: 'RS',
  L1: 'LB',
  L2: 'LT',
  L3: 'LS',
  'Left Stick Deadzone': 7849,
  'Right Stick Deadzone': 8689,
  'Left Stick Anti-Deadzone': 4259,
  'Right Stick Anti-Deadzone': 4259,
  'Left Trigger Threshold': 30,
  'Right Trigger Threshold': 30
}

/** Require a YAML mapping; malformed user files are never replaced with defaults. */
function mapping(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(`Invalid RPCS3 configuration mapping: ${name}`)
  return value
}

/** Refuse symlinks/junctions so portable configuration writes cannot escape userData. */
function ownedPath(root, file) {
  const rel = relative(resolve(root), resolve(file))
  if (rel === '..' || rel.startsWith('..' + sep) || resolve(root, rel) !== resolve(file))
    throw Error('Invalid RPCS3 configuration path.')
  let current = resolve(root)
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    current = join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw Error('Linked RPCS3 configuration path.')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

/** Bounded safe YAML input; comments are retained in the first-change backup. */
function read(root, file) {
  ownedPath(root, file)
  if (!fs.existsSync(file)) return {}
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw Error('Invalid RPCS3 configuration file size.')
  return mapping(load(fs.readFileSync(file, 'utf8'), { schema: JSON_SCHEMA }) ?? {}, file)
}

/** Save changed files atomically, keeping an original backup; leave unchanged files untouched. */
function write(root, file, before, after) {
  if (fs.existsSync(file) && isDeepStrictEqual(before, after)) return
  ownedPath(root, file)
  fs.mkdirSync(dirname(file), { recursive: true })
  const backup = file + '.zenith-backup'
  ownedPath(root, backup)
  if (fs.existsSync(file) && !fs.existsSync(backup))
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temporary, dump(after, { schema: JSON_SCHEMA, noRefs: true, lineWidth: -1 }), {
      flag: 'wx'
    })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

/**
 * Prepare global defaults immediately before spawning RPCS3. No cache is deleted, moved or
 * recreated. Existing non-keyboard controller profiles and title-specific overrides survive.
 * Windows uses portable/config/; Linux uses portable/ directly. Only Windows has XInput.
 * @param {{configDirectory: string, platform: string}} options - Main-owned portable profile.
 */
export function prepareRpcs3Config({ configDirectory, platform }) {
  const configRoot = join(configDirectory, ...(platform === 'win32' ? ['config'] : []))
  const configFile = join(configRoot, 'config.yml')
  const before = read(configDirectory, configFile)
  // Current Windows RPCS3 migrates this deprecated file itself. Seed its replacement without
  // discarding the user's old renderer/audio/VFS-independent options.
  const seed =
    platform === 'win32' && !fs.existsSync(configFile)
      ? read(configDirectory, join(configDirectory, 'config.yml'))
      : before
  const config = structuredClone(seed)
  for (const [section, values] of Object.entries(CACHE_SETTINGS)) {
    config[section] = { ...mapping(config[section] ?? {}, section), ...values }
  }

  const updates = []
  if (platform === 'win32') {
    const inputRoot = join(configRoot, 'input_configs')
    const active = read(configDirectory, join(inputRoot, 'active_input_configurations.yml'))
    const profiles = mapping(active['Active Configurations'] ?? {}, 'Active Configurations')
    const name = profiles.global || 'Default'
    if (
      typeof name !== 'string' ||
      !/^[^\\/:*?"<>|]+$/.test(name) ||
      [...name].some((character) => character.charCodeAt(0) < 32) ||
      name === '..' ||
      name === '.'
    )
      throw Error('Invalid RPCS3 active controller profile name.')
    // RPCS3 falls back to Default if the selected global profile does not exist.
    const selected = join(inputRoot, 'global', name + '.yml')
    ownedPath(configDirectory, selected)
    const inputFile = fs.existsSync(selected) ? selected : join(inputRoot, 'global', 'Default.yml')
    const inputBefore = read(configDirectory, inputFile)
    const input = structuredClone(inputBefore)
    const player = mapping(input['Player 1 Input'] ?? {}, 'Player 1 Input')
    if (!player.Handler || ['Keyboard', 'Null'].includes(player.Handler)) {
      input['Player 1 Input'] = {
        ...player,
        Handler: 'XInput',
        Device: 'XInput Pad #1',
        'Buddy Device': '',
        Config: { ...XINPUT_MAPPING }
      }
      updates.push([inputFile, inputBefore, input])
    }
  }
  // Parse and validate all inputs before writing any file. A failed write blocks spawn.
  for (const [file, original, updated] of updates) write(configDirectory, file, original, updated)
  write(configDirectory, configFile, before, config)
}
