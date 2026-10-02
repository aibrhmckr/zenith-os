const { coreBinary } = require('./fixtures/core-archive.cjs')
// Real Electron IPC/renderer; emulator process and native dialogs are test doubles.
const { app, BrowserWindow, dialog } = require('electron')
const { EventEmitter } = require('node:events')
const childProcess = require('node:child_process')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-launcher-test-'))
const gamesDirectory = path.join(fixtureRoot, 'games')
const retroarchDirectory = path.join(fixtureRoot, 'emulators', 'retroarch')
const executable = path.join(retroarchDirectory, 'retroarch.exe')
const coresDirectory = path.join(retroarchDirectory, 'cores')
fs.mkdirSync(gamesDirectory, { recursive: true })
fs.mkdirSync(coresDirectory, { recursive: true })
const biosDirectory = path.join(retroarchDirectory, 'system', 'pcsx2', 'bios')
fs.mkdirSync(biosDirectory, { recursive: true })
fs.writeFileSync(path.join(biosDirectory, 'test-fixture.bin'), Buffer.alloc(4 * 1024 * 1024))
for (const [name, size] of [
  ['scph5501.bin', 512 * 1024],
  ['bios7.bin', 16384],
  ['bios9.bin', 4096],
  ['firmware.bin', 262144]
])
  fs.writeFileSync(path.join(retroarchDirectory, 'system', name), Buffer.alloc(size))
const fixtures = [
  ['PS2', 'iso', 'pcsx2_libretro.dll'],
  ['PS1', 'cue', 'duckstation_libretro.dll'],
  ['PSP', 'cso', 'ppsspp_libretro.dll'],
  ['NDS', 'nds', 'melonds_libretro.dll'],
  ['N64', 'z64', 'mupen64plus_next_libretro.dll'],
  ['GBA', 'gba', 'mgba_libretro.dll'],
  ['SNES', 'sfc', 'snes9x_libretro.dll'],
  ['NES', 'nes', 'mesen_libretro.dll'],
  ['Genesis', 'gen', 'genesis_plus_gx_libretro.dll']
]
for (const [, extension] of fixtures) {
  fs.writeFileSync(path.join(gamesDirectory, `Özel oyun & test.${extension}`), '')
}
app.getAppPath = () => fixtureRoot
app.setPath('userData', path.join(fixtureRoot, 'profile'))
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = () => {}
const windowActions = []
for (const action of ['hide', 'restore', 'focus']) {
  BrowserWindow.prototype[action] = () => windowActions.push(action)
}
const dialogs = []
let deferDialog = false
let dismissDialog
dialog.showMessageBox = async (...args) => {
  dialogs.push(args.at(-1))
  if (deferDialog) {
    return new Promise((resolve) => {
      dismissDialog = () => {
        deferDialog = false
        resolve({ response: 0 })
      }
    })
  }
  return { response: 0 }
}
const spawns = []
let synchronousFailure = false
childProcess.spawn = (command, args, options) => {
  if (synchronousFailure) throw new Error('simulated spawn failure')
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  spawns.push({ command, args, options, child })
  return child
}

async function waitFor(check) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out: ${check.toString()}`)
}

async function checkLauncher(window) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const gamePath = path.join(gamesDirectory, 'Özel oyun & test.iso')
  const launchCall = (rom = gamePath, system = 'PS2') =>
    `window.electronAPI.launchGame(${JSON.stringify(rom)}, ${JSON.stringify(system)})`
  const begin = async (rom, system) => {
    const count = spawns.length
    await evaluate(
      `window.launchResult = null; void ${launchCall(rom, system)}.then(result => { window.launchResult = result }); undefined`
    )
    await waitFor(() => spawns.length === count + 1)
    return spawns.at(-1)
  }
  const finish = async (child, code = 0) => {
    child.emit('close', code, null)
    await waitFor(() => evaluate('window.launchResult !== null'))
    return evaluate('window.launchResult')
  }
  const overlayGone = () =>
    waitFor(() => evaluate("!document.querySelector('[role=status][aria-live]')"))

  await waitFor(() => evaluate("document.querySelectorAll('[data-game-card]').length === 9"))
  let result = await evaluate(launchCall())
  assert.equal(result.success, false)
  assert.equal(
    dialogs.at(-1).message,
    `RetroArch was not found. Please add retroarch.exe to ${retroarchDirectory}.`
  )
  assert.equal(spawns.length, 0)
  assert.equal(windowActions.length, 0)

  fs.writeFileSync(executable, '')
  result = await evaluate(launchCall())
  assert.match(result.error, /missing_core/)
  result = await evaluate(launchCall(gamePath, 'GameCube'))
  assert.match(result.error, /platform does not match/)
  result = await evaluate(launchCall(path.join(gamesDirectory, 'missing.iso')))
  assert.match(result.error, /Game file is missing/)
  result = await evaluate(launchCall(gamePath, 'GBA'))
  assert.match(result.error, /platform does not match/)
  assert.equal(spawns.length, 0)

  for (const [system, extension, core] of fixtures) {
    fs.writeFileSync(path.join(coresDirectory, core), coreBinary(core))
    const rom = path.join(gamesDirectory, `Özel oyun & test.${extension}`)
    const call = await begin(rom, system)
    assert.equal(call.command, executable)
    assert.deepEqual(call.args.slice(0, 4), ['-L', path.join(coresDirectory, core), rom, '-f'])
    assert.equal(call.options.cwd, retroarchDirectory)
    assert.equal(call.options.shell, false)
    assert.equal(call.options.detached, true)
    assert.equal(call.args[4], '--appendconfig')
    assert(path.isAbsolute(call.args[5]), 'Append config must not depend on RetroArch cwd')
    assert(fs.statSync(call.args[5]).isFile(), 'Session config must exist before spawn')
    const sessionConfig = fs.readFileSync(call.args[5], 'utf8')
    assert.match(sessionConfig, /pause_nonactive = true/)
    for (const setting of [
      'video_vsync = "true"',
      'video_refresh_rate = "60.0"',
      'audio_sync = "true"',
      'audio_rate_control = "true"',
      'fastforward_ratio = "1.0"',
      'video_max_swapchain_images = "3"',
      'vrr_runloop_enable = "true"',
      'notification_show_osd = "false"',
      'notification_show_autoconfig = "false"',
      'video_osd_widgets = "false"',
      'notification_show_core_load = "false"',
      'video_font_enable = "false"',
      'audio_driver = "xaudio"',
      'audio_enable = "true"',
      'audio_mute_enable = "false"',
      'audio_volume = "0.0"',
      'input_menu_toggle_gamepad_combo = "0"',
      'input_menu_toggle_btn = "nul"',
      'input_menu_toggle = "nul"',
      'input_menu_toggle_axis = "nul"',
      'input_menu_toggle_mbtn = "nul"',
      'input_hotkey_block_delay = "0"',
      'auto_overrides_enable = "false"',
      'input_enable_hotkey = "nul"',
      'input_enable_hotkey_btn = "nul"'
    ])
      assert.equal(
        sessionConfig.split('\n').filter((line) => line === setting).length,
        1,
        `${system}: ${setting}`
      )
    assert(!sessionConfig.includes('vrr_runloop_enable = "false"'))
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'])
    const beforeSpawn = windowActions.length
    call.child.emit('spawn')
    assert.deepEqual(windowActions.slice(beforeSpawn), ['hide'])
    const beforeDuplicate = spawns.length
    assert.equal((await evaluate(launchCall(rom, system))).success, false)
    assert.equal(spawns.length, beforeDuplicate, 'Concurrent sessions are rejected')
    assert.equal((await finish(call.child)).success, true)
    assert.deepEqual(windowActions.slice(-2), ['restore', 'focus'])
  }

  // Both process streams must reach the main terminal.
  const output = []
  const originalLog = console.log
  try {
    console.log = (message) => output.push(message)
    spawns.at(-1).child.stdout.emit('data', Buffer.from('core loaded'))
    spawns.at(-1).child.stderr.emit('data', Buffer.from('core crash details'))
  } finally {
    console.log = originalLog
  }
  assert.deepEqual(output, [
    '[RetroArch stdout] core loaded',
    '[RetroArch stderr] core crash details'
  ])

  // PS2 prefers PCSX2 and falls back to LRPS2 from the same cores directory.
  fs.renameSync(
    path.join(coresDirectory, 'pcsx2_libretro.dll'),
    path.join(coresDirectory, 'pcsx2.disabled')
  )
  fs.writeFileSync(
    path.join(coresDirectory, 'lrps2_libretro.dll'),
    coreBinary('lrps2_libretro.dll')
  )
  let call = await begin()
  assert.equal(call.args[1], path.join(coresDirectory, 'lrps2_libretro.dll'))
  await finish(call.child)
  fs.renameSync(
    path.join(coresDirectory, 'pcsx2.disabled'),
    path.join(coresDirectory, 'pcsx2_libretro.dll')
  )
  call = await begin()
  assert.equal(call.args[1], path.join(coresDirectory, 'pcsx2_libretro.dll'))
  await finish(call.child)

  // ISO hints use PPSSPP through the real scanner and launch validation.
  for (const name of [
    'Portable (PSP).iso',
    'Portable pSp.ISO',
    'Grand Theft Auto - Vice City Stories (USA).iso'
  ]) {
    const rom = path.join(gamesDirectory, name)
    fs.writeFileSync(rom, '')
    call = await begin(rom, 'PSP')
    assert.deepEqual(call.args.slice(0, 4), [
      '-L',
      path.join(coresDirectory, 'ppsspp_libretro.dll'),
      rom,
      '-f'
    ])
    await finish(call.child)
    assert.equal((await evaluate(launchCall(rom, 'PS2'))).success, false)
  }

  // PS1 fallback and priority when both cores are installed.
  fs.renameSync(
    path.join(coresDirectory, 'duckstation_libretro.dll'),
    path.join(coresDirectory, 'duckstation.disabled')
  )
  fs.writeFileSync(
    path.join(coresDirectory, 'mednafen_psx_hw_libretro.dll'),
    coreBinary('mednafen_psx_hw_libretro.dll')
  )
  call = await begin(path.join(gamesDirectory, 'Özel oyun & test.cue'), 'PS1')
  assert.equal(call.args[1], path.join(coresDirectory, 'mednafen_psx_hw_libretro.dll'))
  await finish(call.child)
  fs.renameSync(
    path.join(coresDirectory, 'duckstation.disabled'),
    path.join(coresDirectory, 'duckstation_libretro.dll')
  )
  call = await begin(path.join(gamesDirectory, 'Özel oyun & test.cue'), 'PS1')
  assert.equal(call.args[1], path.join(coresDirectory, 'duckstation_libretro.dll'))
  await finish(call.child)

  // Spawn failures emit both error and close; report and restore only once.
  call = await begin()
  const beforeErrorDialogs = dialogs.length
  const beforeErrorActions = windowActions.length
  call.child.emit('error', new Error('simulated ENOENT'))
  result = await finish(call.child, -2)
  assert.equal(result.success, false)
  assert.match(result.error, /simulated ENOENT/)
  assert.equal(dialogs.length, beforeErrorDialogs + 1)
  assert.deepEqual(windowActions.slice(beforeErrorActions), ['restore', 'focus'])
  call = await begin()
  call.child.emit('spawn')
  assert.match((await finish(call.child, 1)).error, /exited unexpectedly/)
  synchronousFailure = true
  assert.match((await evaluate(launchCall())).error, /simulated spawn failure/)
  synchronousFailure = false

  // UI button, launch animation, Enter on a selected card, and held gamepad A.
  await evaluate("document.querySelector('[data-game-card][aria-label$=test]').click()")
  let count = spawns.length
  await evaluate("document.querySelector('[data-launch-game]').click()")
  await waitFor(() => spawns.length === count + 1)
  assert(
    await evaluate(
      "document.querySelector('[role=status][aria-live]').textContent.includes('Launching game')"
    )
  )
  call = spawns.at(-1)
  call.child.emit('spawn')
  await overlayGone()
  await evaluate(
    "document.querySelector('[data-launch-game]').click(); document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))"
  )
  assert.equal(spawns.length, count + 1)
  call.child.emit('close', 0, null)
  await overlayGone()
  count = spawns.length
  await evaluate(
    "document.querySelector('[data-game-card][aria-pressed=true]').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}))"
  )
  await waitFor(() => spawns.length === count + 1)
  spawns.at(-1).child.emit('spawn')
  spawns.at(-1).child.emit('close', 0, null)
  await overlayGone()
  count = spawns.length
  await evaluate(
    "document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, repeat: true}))"
  )
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(spawns.length, count)
  await evaluate(
    "window.testPad = {connected: true, axes: [0, 0], buttons: Array.from({length: 16}, () => ({pressed: false}))}; Object.defineProperty(navigator, 'getGamepads', {configurable: true, value: () => [window.testPad]}); window.testPad.buttons[0].pressed = true"
  )
  await waitFor(() => spawns.length === count + 1)
  spawns.at(-1).child.emit('spawn')
  spawns.at(-1).child.emit('close', 0, null)
  await overlayGone()
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(spawns.length, count + 1, 'Held A does not relaunch after emulator exit')
  await evaluate('window.testPad.buttons[0].pressed = false')

  // Failed UI launch clears the animation and allows retry.
  count = spawns.length
  await evaluate("document.querySelector('[data-launch-game]').click()")
  await waitFor(() => spawns.length === count + 1)
  deferDialog = true
  spawns.at(-1).child.emit('error', new Error('UI spawn failure'))
  spawns.at(-1).child.emit('close', -1, null)
  await overlayGone()
  assert.equal(await evaluate("document.querySelector('[data-launch-game]').disabled"), false)
  dismissDialog()
  await waitFor(() =>
    evaluate("document.querySelector('[role=alert]')?.textContent.includes('UI spawn failure')")
  )
  assert(
    await evaluate(
      "document.querySelector('[role=alert]').textContent.includes('UI spawn failure')"
    )
  )
  assert.equal(await evaluate("document.querySelector('[data-launch-game]').disabled"), false)

  // Retrying works after a dismissed error; an abnormal playing-session exit also clears state.
  count = spawns.length
  await evaluate("document.querySelector('[data-launch-game]').click()")
  await waitFor(() => spawns.length === count + 1)
  spawns.at(-1).child.emit('spawn')
  await overlayGone()
  deferDialog = true
  spawns.at(-1).child.emit('close', 1, null)
  await overlayGone()
  assert.equal(await evaluate("document.querySelector('[data-launch-game]').disabled"), false)
  dismissDialog()
  await waitFor(() =>
    evaluate("document.querySelector('[role=alert]')?.textContent.includes('exited unexpectedly')")
  )
  console.log(
    'PASS: PSP ISO launch, PS2/PS1 core fallback, stdout/stderr, spawn arguments, dialogs, concurrent launch guard, lifecycle, animation reset before dialog dismissal, retry, Enter and simulated gamepad A'
  )
}

const timeout = setTimeout(() => {
  console.error('Launcher test timed out')
  app.exit(1)
}, 90000)
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      await checkLauncher(window)
      clearTimeout(timeout)
      app.exit(0)
    } catch (error) {
      console.error(error)
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
// Do not contact the CDN for synthetic ROM fixtures.
globalThis.fetch = async () => new Response('', { status: 503 })
require('../out/main/index.js')
