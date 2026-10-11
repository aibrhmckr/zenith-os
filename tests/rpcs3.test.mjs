import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { load, dump } from 'js-yaml'
import { createRequire } from 'node:module'
import { createRpcs3Runtime } from '../src/main/services/rpcs3Runtime.js'
const { coreBinary } = createRequire(import.meta.url)('./fixtures/core-archive.cjs')

// All files are synthetic markers, never real emulator, game or firmware binaries.
test('status exposes only a release version matching the physical executable', (t) => {
  const f = fixture(t)
  f.executable()
  f.firmware()
  const stat = fs.statSync(f.runtime.executable)
  const metadata = path.join(f.runtime.directory, 'zenith-release.json')
  assert.equal(f.runtime.status().installedVersion, null)
  fs.writeFileSync(
    metadata,
    JSON.stringify({
      installedVersion: 'v0.0.38-12345',
      executableSize: stat.size,
      executableMtimeMs: stat.mtimeMs
    })
  )
  assert.equal(f.runtime.status().installedVersion, 'v0.0.38-12345')
  fs.appendFileSync(f.runtime.executable, 'changed')
  assert.equal(f.runtime.status().installedVersion, null)
  fs.writeFileSync(metadata, '{broken')
  assert.equal(f.runtime.status().installedVersion, null)
  assert.equal(
    f.runtime.status().ready,
    true,
    'Optional metadata cannot invalidate a working runtime'
  )
  fs.unlinkSync(f.runtime.executable)
  assert.equal(f.runtime.status().ready, false)
})

function fixture(t, platform = 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-rpcs3-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtime = createRpcs3Runtime({ userData: root, platform })
  runtime.ensureDirectories()
  const game = path.join(root, 'Özel & game (PS3).iso')
  fs.writeFileSync(game, 'synthetic fixture')
  const executable = () => {
    fs.writeFileSync(
      runtime.executable,
      coreBinary(platform === 'win32' ? 'fixture.exe' : 'fixture.so')
    )
    fs.chmodSync(runtime.executable, 0o755)
  }
  const firmware = (directory = path.join(runtime.configDirectory, 'dev_flash')) => {
    fs.mkdirSync(path.join(directory, 'sys/external'), { recursive: true })
    fs.mkdirSync(path.join(directory, 'vsh/etc'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'sys/external/liblv2.sprx'), Buffer.from([83, 67, 69, 0]))
    fs.writeFileSync(path.join(directory, 'vsh/etc/version.txt'), 'release:04.9200:\nbuild:fixture')
    return directory
  }
  return { root, runtime, game, executable, firmware }
}

test('RPCS3 readiness checks executable and installed firmware, not a PUP', (t) => {
  const f = fixture(t)
  assert.equal(f.runtime.prepareLaunch(f.game).error, 'missing_rpcs3')
  fs.writeFileSync(f.runtime.executable, 'invalid')
  assert.equal(f.runtime.status().executableReady, false)
  f.executable()
  fs.writeFileSync(path.join(f.runtime.directory, 'PS3UPDAT.PUP'), 'not installed')
  assert.equal(f.runtime.prepareLaunch(f.game).error, 'missing_ps3_firmware')
  const flash = f.firmware()
  assert.equal(f.runtime.status().ready, true)
  assert.equal(f.runtime.status().firmware.version, '04.9200')
  fs.unlinkSync(path.join(flash, 'sys/external/liblv2.sprx'))
  assert.equal(f.runtime.status().ready, false)
  f.firmware()
  fs.writeFileSync(path.join(flash, 'vsh/etc/version.txt'), 'incomplete')
  assert.equal(f.runtime.status().ready, false)
  fs.unlinkSync(f.runtime.executable)
  assert.equal(f.runtime.status().error, 'missing_rpcs3')
})

test('PS3 plans use absolute paths, safe argv and refuse PKG boot', (t) => {
  const f = fixture(t)
  f.executable()
  f.firmware()
  const plan = f.runtime.prepareLaunch(f.game)
  assert.equal(plan.success, true)
  assert.equal(plan.executable, path.join(f.root, 'emulators/rpcs3/rpcs3.exe'))
  assert.equal(plan.cwd, f.runtime.directory)
  assert.deepEqual(plan.args, ['--no-gui', f.game])
  const eboot = path.join(f.root, 'Game/PS3_GAME/USRDIR/EBOOT.BIN')
  fs.mkdirSync(path.dirname(eboot), { recursive: true })
  fs.writeFileSync(eboot, 'synthetic')
  assert.equal(f.runtime.prepareLaunch(eboot).success, true)
  const pkg = path.join(f.root, 'game.pkg')
  fs.writeFileSync(pkg, 'synthetic')
  assert.equal(f.runtime.prepareLaunch(pkg).error, 'ps3_package_not_installed')
  assert.equal(f.runtime.prepareLaunch(f.root).error, 'ps3_game_missing')
  const bin = path.join(f.root, 'random.bin')
  fs.writeFileSync(bin, 'synthetic')
  assert.equal(f.runtime.prepareLaunch(bin).error, 'ps3_invalid_game')
})

test('custom VFS firmware paths are honored and malformed YAML blocks launch', (t) => {
  const f = fixture(t)
  f.executable()
  f.firmware()
  const config = path.join(f.runtime.configDirectory, 'config/vfs.yml')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  const other = path.join(f.root, 'alternate firmware')
  fs.writeFileSync(config, '"/dev_flash/": ' + JSON.stringify(other))
  assert.equal(f.runtime.status().firmware.directory, other)
  assert.equal(f.runtime.status().ready, false)
  f.firmware(other)
  assert.equal(f.runtime.status().ready, true)
  fs.writeFileSync(
    config,
    '"$(EmulatorDir)": ' +
      JSON.stringify(f.root) +
      '\n"/dev_flash/": "$(EmulatorDir)alternate firmware/"'
  )
  assert.equal(f.runtime.status().ready, true)
  fs.writeFileSync(config, '[malformed')
  assert.equal(f.runtime.prepareLaunch(f.game).error, 'rpcs3_status_failed')
  fs.writeFileSync(config, 'x'.repeat(65537))
  assert.equal(f.runtime.status().ready, false)
})

test('Linux uses native executable and portable VFS; unsupported hosts fail safely', (t) => {
  const f = fixture(t, 'linux')
  f.executable()
  f.firmware()
  assert.equal(f.runtime.status().ready, true)
  const plan = f.runtime.prepareLaunch(f.game)
  assert.equal(path.basename(plan.executable), 'rpcs3')
  assert.equal(plan.env.APPIMAGE, undefined)
  assert.equal(plan.env.APPDIR, undefined)
  assert.equal(plan.env.XDG_CACHE_HOME, path.join(f.runtime.directory, 'cache'))
  fs.writeFileSync(path.join(f.runtime.configDirectory, 'vfs.yml'), '"/dev_flash/": "missing/"')
  assert.equal(f.runtime.status().ready, false)
  assert.equal(
    createRpcs3Runtime({ userData: f.root, platform: 'darwin' }).status().error,
    'unsupported_rpcs3_host'
  )
})

function profileFiles(f) {
  const dir = path.join(f.runtime.configDirectory, 'config')
  return {
    config: path.join(dir, 'config.yml'),
    input: path.join(dir, 'input_configs/global/Default.yml'),
    active: path.join(dir, 'input_configs/active_input_configurations.yml')
  }
}
function writeYaml(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, dump(data))
}
const readYaml = (file) => load(fs.readFileSync(file, 'utf8'))

test('launch config enables persistent LLVM/SPU/shader caches and Xbox P1 without cache deletion', (t) => {
  const f = fixture(t)
  f.executable()
  f.firmware()
  const files = profileFiles(f)
  const cache = path.join(f.runtime.configDirectory, 'cache/test-ppu.obj')
  fs.mkdirSync(path.dirname(cache), { recursive: true })
  fs.writeFileSync(cache, 'cached module')
  assert.equal(f.runtime.prepareLaunch(f.game).success, true)
  const config = readYaml(files.config)
  assert.equal(config.Core['PPU Decoder'], 'Recompiler (LLVM)')
  assert.equal(config.Core['LLVM Precompilation'], true)
  assert.equal(config.Core['SPU Cache'], true)
  assert.equal(config.Video['Shader Mode'], 'Async Recompiler (multi-threaded)')
  assert.equal(config.Video['Disable On-Disk Shader Cache'], false)
  const p1 = readYaml(files.input)['Player 1 Input']
  assert.equal(p1.Handler, 'XInput')
  assert.equal(p1.Device, 'XInput Pad #1')
  assert.equal(p1.Config.Cross, 'A')
  assert.equal(p1.Config.Select, 'Back')
  assert.equal(p1.Config['Left Stick Up'], 'LS Y+')
  const mtime = fs.statSync(files.config).mtimeMs
  const inputMtime = fs.statSync(files.input).mtimeMs
  assert.equal(f.runtime.prepareLaunch(f.game).success, true)
  assert.equal(fs.statSync(files.config).mtimeMs, mtime)
  assert.equal(fs.statSync(files.input).mtimeMs, inputMtime)
  assert.equal(fs.readFileSync(cache, 'utf8'), 'cached module')
})

test('active keyboard profile is migrated with a backup; other players and unrelated settings survive', (t) => {
  const f = fixture(t)
  f.executable()
  f.firmware()
  const files = profileFiles(f)
  const custom = path.join(path.dirname(files.input), 'Living Room.yml')
  writeYaml(files.active, { 'Active Configurations': { global: 'Living Room' } })
  const original = {
    'Player 1 Input': { Handler: 'Keyboard', Device: 'Keyboard', Config: { Cross: 'K' } },
    'Player 2 Input': { Handler: 'DualSense', Device: 'custom', Config: { Cross: 'Circle' } }
  }
  writeYaml(custom, original)
  writeYaml(files.config, {
    Audio: { 'Master Volume': 73 },
    Core: { 'SPU Cache': false, 'PPU Threads': 3 },
    Video: { Renderer: 'Vulkan', 'Disable On-Disk Shader Cache': true }
  })
  assert.equal(f.runtime.prepareLaunch(f.game).success, true)
  assert.equal(readYaml(custom)['Player 1 Input'].Config.Cross, 'A')
  assert.deepEqual(readYaml(custom)['Player 2 Input'], {
    ...original['Player 2 Input'],
    Config: { Cross: 'Circle', 'PS Button': '' }
  })
  assert.deepEqual(readYaml(custom + '.zenith-backup'), original)
  assert.equal(fs.existsSync(files.input), false, 'Do not create an unused default profile')
  assert.equal(readYaml(files.config).Audio['Master Volume'], 73)
  assert.equal(readYaml(files.config).Core['PPU Threads'], 3)
  assert.equal(readYaml(files.config).Video.Renderer, 'Vulkan')
})

test('existing controller mappings survive except the reserved PS/Home button', (t) => {
  const f = fixture(t)
  f.executable()
  f.firmware()
  const { input } = profileFiles(f)
  for (const handler of ['XInput', 'DualShock 4', 'DualSense', 'SDL']) {
    const data = {
      'Player 1 Input': {
        Handler: handler,
        Device: 'my second device',
        Config: { Cross: 'custom' }
      }
    }
    writeYaml(input, data)
    assert.equal(f.runtime.prepareLaunch(f.game).success, true)
    assert.deepEqual(readYaml(input), {
      ...data,
      'Player 1 Input': { ...data['Player 1 Input'], Config: { Cross: 'custom', 'PS Button': '' } }
    })
  }
})

test('game-window shortcuts and per-title PS buttons are disabled with original backups', (t) => {
  const f = fixture(t)
  f.executable()
  f.firmware()
  const files = profileFiles(f)
  const ini = path.join(path.dirname(files.config), 'GuiConfigs/CurrentSettings.ini')
  fs.mkdirSync(path.dirname(ini), { recursive: true })
  const original = '[GSFrame]\ndisableKbHotkeys=false\ngeometry=abc\n[Other]\ntheme=dark\n'
  fs.writeFileSync(ini, original)
  const titleInput = path.join(path.dirname(files.config), 'input_configs/BLUS12345/Pad.yml')
  writeYaml(titleInput, {
    'Player 1 Input': { Handler: 'XInput', Config: { Cross: 'A', 'PS Button': 'Guide' } }
  })
  assert.equal(f.runtime.prepareLaunch(f.game).success, true)
  assert.match(fs.readFileSync(ini, 'utf8'), /disableKbHotkeys=true/)
  assert.match(fs.readFileSync(ini, 'utf8'), /geometry=abc/)
  assert.match(fs.readFileSync(ini, 'utf8'), /\[Other\]\ntheme=dark/)
  assert.equal(fs.readFileSync(ini + '.zenith-backup', 'utf8'), original)
  assert.deepEqual(readYaml(titleInput)['Player 1 Input'].Config, { Cross: 'A', 'PS Button': '' })
  const mtime = fs.statSync(ini).mtimeMs
  assert.equal(f.runtime.prepareLaunch(f.game).success, true)
  assert.equal(fs.statSync(ini).mtimeMs, mtime)
})

test('legacy settings are seeded; missing active profile falls back to Default', (t) => {
  const f = fixture(t)
  f.executable()
  f.firmware()
  const files = profileFiles(f)
  writeYaml(path.join(f.runtime.configDirectory, 'config.yml'), { Audio: { 'Master Volume': 82 } })
  writeYaml(files.active, { 'Active Configurations': { global: 'Missing' } })
  assert.equal(f.runtime.prepareLaunch(f.game).success, true)
  assert.equal(readYaml(files.config).Audio['Master Volume'], 82)
  assert.equal(readYaml(files.input)['Player 1 Input'].Handler, 'XInput')
})

test('invalid YAML, profile paths and blocked config writes prevent launch without destroying originals', (t) => {
  const f = fixture(t)
  f.executable()
  f.firmware()
  const files = profileFiles(f)
  for (const content of ['[broken', 'Core: []', 'Video: false', 'x'.repeat(1024 * 1024 + 1)]) {
    fs.mkdirSync(path.dirname(files.config), { recursive: true })
    fs.writeFileSync(files.config, content)
    assert.equal(f.runtime.prepareLaunch(f.game).error, 'rpcs3_config_failed')
    assert.equal(fs.readFileSync(files.config, 'utf8'), content)
    assert.equal(fs.existsSync(files.input), false)
  }
  writeYaml(files.config, {})
  writeYaml(files.active, { 'Active Configurations': { global: '../../escape' } })
  assert.equal(f.runtime.prepareLaunch(f.game).error, 'rpcs3_config_failed')
  writeYaml(files.active, {})
  fs.mkdirSync(files.config + '.zenith-backup')
  // A non-file target cannot be atomically replaced; no emulator plan is returned.
  fs.unlinkSync(files.config)
  fs.mkdirSync(files.config)
  assert.equal(f.runtime.prepareLaunch(f.game).error, 'rpcs3_config_failed')
})

test('Linux applies cache settings in portable root without an unsupported XInput handler', (t) => {
  const f = fixture(t, 'linux')
  f.executable()
  f.firmware()
  const input = path.join(f.runtime.configDirectory, 'input_configs/global/Default.yml')
  const settings = { 'Player 1 Input': { Handler: 'SDL', Device: 'Steam Deck' } }
  writeYaml(input, settings)
  assert.equal(f.runtime.prepareLaunch(f.game).success, true)
  assert.equal(readYaml(path.join(f.runtime.configDirectory, 'config.yml')).Core['SPU Cache'], true)
  assert.deepEqual(readYaml(input), {
    ...settings,
    'Player 1 Input': { ...settings['Player 1 Input'], Config: { 'PS Button': '' } }
  })
  assert.equal(fs.existsSync(path.join(f.runtime.configDirectory, 'config/config.yml')), false)
})

test('atomic publication failure preserves the old file and removes partial temporary files', (t) => {
  const f = fixture(t)
  f.executable()
  f.firmware()
  const files = profileFiles(f)
  writeYaml(files.config, { Core: { 'SPU Cache': false } })
  const original = fs.readFileSync(files.config, 'utf8')
  // Input does not need migration: the failing rename belongs to config.yml.
  writeYaml(files.input, { 'Player 1 Input': { Handler: 'XInput', Device: 'XInput Pad #2' } })
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(Error('Fixture write denied'), { code: 'EACCES' })
  })
  const plan = f.runtime.prepareLaunch(f.game)
  assert.equal(plan.error, 'rpcs3_config_failed')
  assert.match(plan.message, /Fixture write denied/)
  assert.equal(fs.readFileSync(files.config, 'utf8'), original)
  assert.equal(fs.readFileSync(files.config + '.zenith-backup', 'utf8'), original)
  assert.equal(
    fs.readdirSync(path.dirname(files.config)).some((file) => file.endsWith('.tmp')),
    false
  )
})
