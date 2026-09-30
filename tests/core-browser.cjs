const { app, BrowserWindow, dialog } = require('electron')
const { EventEmitter } = require('node:events')
const cp = require('node:child_process'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict')
const { coreArchive } = require('./fixtures/core-archive.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-core-ui-'))
app.getAppPath = () => root
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
fs.mkdirSync(path.join(root, 'games'), { recursive: true })
fs.writeFileSync(path.join(root, 'games', 'Example.a26'), 'synthetic')
fs.mkdirSync(path.join(root, 'emulators', 'retroarch'), { recursive: true })
fs.writeFileSync(path.join(root, 'emulators', 'retroarch', 'retroarch.exe'), '')
for (const action of ['show', 'hide', 'restore', 'focus', 'setAlwaysOnTop'])
  BrowserWindow.prototype[action] = () => {}
let nativeErrors = 0
dialog.showMessageBox = async () => {
  nativeErrors++
  return { response: 0 }
}
globalThis.fetch = async (url) =>
  url.endsWith('/latest/')
    ? new Response(
        '<a href="mesen_libretro.dll.zip">Mesen</a><a href="stella_libretro.dll.zip">Stella</a>'
      )
    : url.endsWith('stella_libretro.dll.zip')
      ? new Response(coreArchive('stella_libretro.dll'))
      : new Response('', { status: 404 })
let child, args
cp.spawn = (_command, argv) => {
  args = argv
  child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {
    child.killed = true
    child.emit('exit', 0)
    return true
  }
  setTimeout(() => child.emit('spawn'), 10)
  return child
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function run(win) {
  const evalJS = (code) => win.webContents.executeJavaScript(code)
  const wait = async (code) => {
    for (let n = 0; n < 200; n++) {
      if (await evalJS(code)) return
      await delay(20)
    }
    throw Error('Timeout ' + code)
  }
  const click = (selector) =>
    evalJS(`document.querySelector(${JSON.stringify(selector)}).click();undefined`)
  const pad = async (button, move = null) => {
    await evalJS(
      `document.documentElement.dataset.inputMode='gamepad';Array.from(document.querySelectorAll('dialog[open]')).at(-1).dispatchEvent(new CustomEvent('controller-input',{detail:{hit:i=>i===${button},move:${JSON.stringify(move)},axes:[0,0,0,0],now:performance.now(),inputMode:'gamepad'}}));undefined`
    )
    await delay(35)
  }
  await wait("document.querySelectorAll('[data-game-card]').length===1")
  await evalJS(
    "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));undefined"
  )
  await wait("!!document.querySelector('[data-console-modal=core][open]')")
  assert.equal(nativeErrors, 0, 'Atari missing core uses the Zenith modal')
  await click('[data-browse-cores]')
  await wait("document.querySelectorAll('[data-core-choice]').length===2")
  assert(await evalJS("document.activeElement.matches('[data-core-search]')"))
  await pad(0)
  await wait("!!document.querySelector('[data-osk][open]')")
  for (const letter of ['S', 'T', 'E']) await click(`[data-osk-action="${letter}"]`)
  await wait("document.querySelectorAll('[data-core-choice]').length===1")
  assert(await evalJS("!!document.querySelector('[data-osk][open]')"), 'Filters live before Done')
  assert.equal(
    await evalJS("document.querySelector('[data-core-choice]').dataset.coreChoice"),
    'stella_libretro.dll'
  )
  await pad(1)
  await wait("!document.querySelector('[data-osk]')")
  await pad(-1, 'down')
  assert(await evalJS("document.activeElement.matches('[data-core-choice]')"))
  await pad(0)
  for (let n = 0; n < 100 && !child; n++) await delay(25)
  assert(child, 'Selected core installs and launches')
  assert.equal(
    args[args.indexOf('-L') + 1],
    path.join(root, 'emulators', 'retroarch', 'cores', 'stella_libretro.dll')
  )
  assert(fs.existsSync(path.join(root, 'emulators', 'retroarch', 'cores', 'stella_libretro.dll')))
  const games = await evalJS('window.electronAPI.getLocalGames()')
  const selected = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'core-selections.json')))
  assert.equal(selected['game:' + games[0].gameId], 'stella_libretro.dll')
  assert.equal(
    (await evalJS("window.electronAPI.selectCore({gameId:'bad',core:'../evil.dll'})")).success,
    false
  )
  child.kill()
  console.log(
    'PASS: Atari missing-core modal, browsable catalog, live OSK filtering, D-pad focus, safe install, persisted game selection and launch'
  )
}
const timeout = setTimeout(() => {
  console.error('Core browser timeout')
  app.exit(1)
}, 30000)
app.once('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', async () => {
    try {
      await run(win)
      clearTimeout(timeout)
      app.exit(0)
    } catch (error) {
      console.error(error)
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
