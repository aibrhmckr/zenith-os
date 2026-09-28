const { app, BrowserWindow, globalShortcut } = require('electron')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict')
const { EventEmitter } = require('node:events'),
  cp = require('node:child_process')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-hotkeys-')),
  profile = path.join(root, 'profile'),
  retro = path.join(root, 'emulators', 'retroarch')
fs.mkdirSync(path.join(root, 'games'), { recursive: true })
fs.mkdirSync(path.join(retro, 'cores'), { recursive: true })
fs.writeFileSync(path.join(root, 'games', 'Fixture.gba'), 'fixture')
fs.writeFileSync(path.join(retro, 'retroarch.exe'), '')
fs.writeFileSync(path.join(retro, 'cores', 'mgba_libretro.dll'), '')
app.getAppPath = () => root
app.setPath('userData', profile)
app.disableHardwareAcceleration()
for (const action of ['show', 'hide', 'restore', 'focus', 'setAlwaysOnTop'])
  BrowserWindow.prototype[action] = () => {}
let quits = 0
app.quit = () => {
  quits++
}
const shortcuts = new Map()
globalShortcut.register = (key, fn) => {
  shortcuts.set(key, fn)
  return true
}
globalShortcut.unregister = (key) => shortcuts.delete(key)
globalShortcut.unregisterAll = () => shortcuts.clear()
globalThis.fetch = async () => new Response('', { status: 404 })
let emulator, bridge, spawnArgs
const commands = []
cp.spawn = (command, args, options) => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.writable = true
  child.stdin.write = (value) => {
    commands.push(value)
  }
  child.stdin.end = () => {}
  child.kill = () => {
    child.killed = true
    child.emit('exit', 0)
    child.emit('close', 0)
  }
  if (command === 'powershell.exe') {
    bridge = child
    assert.equal(options.windowsHide, true)
  } else {
    emulator = child
    child.pid = 7007
    spawnArgs = args
    setTimeout(() => child.emit('spawn'), 20)
  }
  return child
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function run(window) {
  const ev = (code) => window.webContents.executeJavaScript(code)
  const wait = async (code) => {
    for (let i = 0; i < 180; i++) {
      if (await ev(code)) return
      await delay(20)
    }
    throw Error('Timeout: ' + code)
  }
  const click = (selector) =>
    ev('document.querySelector(' + JSON.stringify(selector) + ').click();undefined')
  const key = async (key, code = key, type = 'keydown') => {
    await ev(
      'document.activeElement.dispatchEvent(new KeyboardEvent(' +
        JSON.stringify(type) +
        ',{key:' +
        JSON.stringify(key) +
        ',code:' +
        JSON.stringify(code) +
        ',bubbles:true,cancelable:true}));undefined'
    )
    await delay(35)
  }
  const buttons = async (ids) => {
    const before = await ev('window.padReads')
    await ev(
      'window.pad.buttons.forEach((b,i)=>b.pressed=' +
        JSON.stringify(ids) +
        '.includes(i));undefined'
    )
    await wait('window.padReads>' + before)
    await delay(35)
  }
  const press = async (index) => {
    await buttons([index])
    await buttons([])
  }
  await wait("document.querySelectorAll('[data-game-card]').length===1")
  await ev(
    "window.pad={connected:true,id:'fixture',index:0,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false}))};window.padReads=0;Object.defineProperty(navigator,'getGamepads',{value:()=>{window.padReads++;return [window.pad]}});undefined"
  )
  await buttons([8])
  assert.equal(await ev("!!document.querySelector('dialog[open]')"), false)
  await buttons([8, 9])
  await wait("!!document.querySelector('[data-console-modal=mainMenu]')")
  await buttons([])
  await press(1)
  await key('ContextMenu')
  await wait("!!document.querySelector('[data-hotkey-setting]')")
  assert.equal(await ev("document.activeElement.getAttribute('role')"), 'combobox')
  await click('[data-hotkey-setting]')
  await key('q', 'KeyQ')
  await wait("document.querySelector('[data-hotkey-listening]').textContent.includes('second key')")
  await key('e', 'KeyE')
  await wait("!document.querySelector('[data-hotkey-listening]')")
  assert.deepEqual((await ev('window.electronAPI.getHotkeys()')).keyboard, ['KeyQ', 'KeyE'])
  await click('[data-hotkey-setting]')
  await key('w', 'KeyW')
  await key('Escape')
  await wait("!document.querySelector('[data-hotkey-listening]')")
  assert.deepEqual((await ev('window.electronAPI.getHotkeys()')).keyboard, ['KeyQ', 'KeyE'])
  await press(1)
  await wait("!document.querySelector('dialog[open]')")
  await key('q', 'KeyQ')
  assert.equal(await ev("!!document.querySelector('dialog[open]')"), false)
  await key('e', 'KeyE')
  await wait("!!document.querySelector('[data-console-modal=mainMenu]')")
  await key('q', 'KeyQ', 'keyup')
  await key('e', 'KeyE', 'keyup')
  await press(1)
  await press(9)
  await wait("!!document.querySelector('[data-console-modal=settings]')")
  await click('[data-hotkey-setting]')
  await press(4)
  await press(5)
  await wait("!document.querySelector('[data-hotkey-listening]')")
  assert.deepEqual((await ev('window.electronAPI.getHotkeys()')).gamepad, [4, 5])
  await click('[data-hotkey-setting]')
  await press(2)
  await press(1)
  await wait("!document.querySelector('[data-hotkey-listening]')")
  assert.deepEqual((await ev('window.electronAPI.getHotkeys()')).gamepad, [4, 5])
  await press(1)
  await buttons([4])
  assert.equal(await ev("!!document.querySelector('dialog[open]')"), false)
  await buttons([4, 5])
  await wait("!!document.querySelector('[data-console-modal=mainMenu]')")
  await buttons([])
  await press(1)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(profile, 'zenith-preferences.json'))).hotkeys,
    { gamepad: [4, 5], keyboard: ['KeyQ', 'KeyE'] }
  )
  assert.deepEqual(await ev("JSON.parse(localStorage.getItem('zenith-preferences')).hotkeys"), {
    gamepad: [4, 5],
    keyboard: ['KeyQ', 'KeyE']
  })
  await click('[data-launch-game]')
  await wait("document.querySelector('[data-launch-game]').disabled")
  for (let i = 0; i < 100 && !bridge; i++) await delay(20)
  assert(bridge)
  assert.deepEqual(JSON.parse(commands[0]), { pad: [4, 5], keys: [81, 69] })
  const config = fs.readFileSync(spawnArgs.at(-1), 'utf8')
  for (const line of [
    'input_menu_toggle_gamepad_combo = "0"',
    'input_menu_toggle_btn = "nul"',
    'input_menu_toggle = "nul"',
    'input_exit_emulator = "nul"'
  ])
    assert(config.includes(line))
  await ev("window.electronAPI.saveHotkeys({gamepad:[8,9],keyboard:['KeyZ','KeyX']})")
  assert.deepEqual(JSON.parse(commands.at(-1)), { pad: [8, 9], keys: [90, 88] })
  bridge.stdout.emit('data', 'ho')
  bridge.stdout.emit('data', 'me\n')
  await wait("!!document.querySelector('[data-console-modal=session]')")
  assert(shortcuts.has('F10'))
  assert(shortcuts.has('Escape'))
  await click('[data-quit-app]')
  assert.equal(quits, 1)
  assert(emulator.killed)
  await wait("!document.querySelector('dialog[open]')")
  await key('F10')
  await wait("!!document.querySelector('[data-console-modal=mainMenu]')")
  await click('[data-quit-app]')
  assert.equal(quits, 2)
  console.log(
    'PASS: keyboard/gamepad remap, cancellation, default and custom chords without leakage, persisted settings, native bridge live updates, RetroArch menu suppression, quit in game and dashboard'
  )
}
const timer = setTimeout(() => {
  console.error('hotkey timeout')
  app.exit(1)
}, 180000)
app.once('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    try {
      await run(window)
      clearTimeout(timer)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.log(await window.webContents.executeJavaScript('document.body.innerText'))
      clearTimeout(timer)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
