// Packaged Main + real renderer/IPC; network and RetroArch are synthetic doubles.
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const { coreArchive, coreBinary } = require('./fixtures/core-archive.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-core-download-'))
const profile = path.join(root, 'profile'),
  resources = path.join(root, 'resources')
const bundled = path.join(resources, 'emulators', 'retroarch')
const destination = path.join(
  profile,
  'emulators',
  'retroarch',
  'cores',
  'mupen64plus_next_libretro.dll'
)
fs.mkdirSync(bundled, { recursive: true })
fs.writeFileSync(path.join(bundled, 'retroarch.exe'), 'synthetic executable')
fs.mkdirSync(path.join(root, 'games'), { recursive: true })
fs.writeFileSync(path.join(root, 'games', 'Example.z64'), 'synthetic ROM')
Object.defineProperty(app, 'isPackaged', { value: true })
Object.defineProperty(process, 'resourcesPath', { value: resources })
process.env.PORTABLE_EXECUTABLE_DIR = root
app.getAppPath = () => root
app.setPath('userData', profile)
app.disableHardwareAcceleration()
for (const method of ['show', 'hide', 'restore', 'focus', 'setAlwaysOnTop'])
  BrowserWindow.prototype[method] = () => {}
let failDownload = true,
  coreRequests = 0,
  downloadGate = null,
  child,
  spawned
dialog.showMessageBox = async () => {
  throw Error('Unexpected native launch error')
}
globalThis.fetch = async (url) => {
  if (!url.endsWith('/mupen64plus_next_libretro.dll.zip')) return new Response('', { status: 404 })
  coreRequests++
  if (downloadGate) await downloadGate
  return failDownload
    ? new Response('', { status: 503 })
    : new Response(coreArchive('mupen64plus_next_libretro.dll'))
}
cp.spawn = (command, args, options) => {
  spawned = { command, args, options }
  child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  setTimeout(() => child.emit('spawn'), 10)
  return child
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const timeout = setTimeout(() => {
  console.error('Core download test timed out')
  app.exit(1)
}, 30000)
app.once('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', async () => {
    try {
      const evaluate = (code) => win.webContents.executeJavaScript(code)
      const wait = async (code) => {
        for (let i = 0; i < 300; i++) {
          if (await evaluate(code)) return
          await delay(20)
        }
        throw Error('Timeout: ' + code)
      }
      const key = (key) =>
        evaluate(
          `document.body.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}));undefined`
        )
      const click = (selector) =>
        evaluate(`document.querySelector(${JSON.stringify(selector)}).click();undefined`)
      await wait("document.querySelectorAll('[data-game-card]').length===1")
      await key('ContextMenu')
      await wait("!!document.querySelector('[data-system-page]')")
      assert.equal(
        await evaluate("document.querySelector('[data-legal-notice]').textContent"),
        'Zenith OS does not bundle ROMs or BIOS files. RetroArch is licensed under GNU GPL v3.'
      )
      await click('[data-system-page]')
      await wait("!!document.querySelector('[data-install-core=N64]')")
      await click('[data-install-core=N64]')
      await wait("document.querySelector('[role=alert]')?.textContent.includes('HTTP 503')")
      assert.equal((await evaluate('window.electronAPI.getSystemStatus()'))[0].core, null)
      assert(!fs.existsSync(destination))
      failDownload = false
      await wait("document.querySelector('[data-install-core=N64]')?.disabled===false")
      await click('[data-install-core=N64]')
      await wait(
        "document.querySelector('[data-core-platform=N64]')?.textContent.includes('Ready')"
      )
      const status = (await evaluate('window.electronAPI.getSystemStatus()'))[0]
      assert.equal(status.corePath, destination)
      assert.deepEqual(fs.readFileSync(destination), coreBinary('mupen64plus_next_libretro.dll'))
      assert(
        !fs.existsSync(path.join(bundled, 'cores')),
        'Resources are not the installation target'
      )
      fs.unlinkSync(destination)
      await wait("!!document.querySelector('[data-install-core=N64]')")
      const games = await evaluate('window.electronAPI.getLocalGames()')
      const launch = `window.electronAPI.launchGame(${JSON.stringify(games[0].path)},'N64')`
      assert.equal((await evaluate(launch)).error, 'missing_core')
      assert.equal(spawned, undefined)
      await click('[data-modal-close]')
      await wait("!!document.querySelector('[data-console-modal=settings][open]')")
      await click('[data-modal-close]')
      await wait("!document.querySelector('dialog[open]')")
      const requestsBeforePrompt = coreRequests
      await click('[data-launch-game]')
      await wait("!!document.querySelector('[data-console-modal=core][open]')")
      assert(
        await evaluate(
          "document.querySelector('[data-console-modal=core]').textContent.includes('N64 emulator core was not found')"
        )
      )
      assert(await evaluate("document.activeElement.matches('[data-download-core]')"))
      assert.equal(
        coreRequests,
        requestsBeforePrompt,
        'Opening prompt never downloads without consent'
      )
      await click('[data-cancel-core]')
      await wait("!document.querySelector('dialog[open]')")
      assert.equal(spawned, undefined, 'Cancel never launches RetroArch')
      assert.equal(coreRequests, requestsBeforePrompt)
      await click('[data-launch-game]')
      await wait("!!document.querySelector('[data-download-core]')")
      failDownload = true
      await click('[data-download-core]')
      await wait("document.querySelector('[role=alert]')?.textContent.includes('HTTP 503')")
      assert.equal(spawned, undefined, 'A failed download cannot launch')
      failDownload = false
      let release
      downloadGate = new Promise((resolve) => {
        release = resolve
      })
      await wait("document.querySelector('[data-download-core]')?.disabled===false")
      await click('[data-download-core]')
      await wait(
        "document.querySelector('[role=status]')?.textContent.includes('Downloading and verifying')"
      )
      assert(await evaluate("document.querySelector('[data-download-core]').disabled"))
      assert.equal(spawned, undefined, 'Download must complete before spawn')
      release()
      for (let i = 0; i < 100 && !spawned; i++) await delay(20)
      assert(spawned)
      assert.equal(spawned.args[spawned.args.indexOf('-L') + 1], destination)
      const config = spawned.args[spawned.args.indexOf('--appendconfig') + 1]
      assert(path.isAbsolute(config))
      assert.equal(config, path.join(profile, 'media', games[0].gameId, 'session.cfg'))
      assert.match(fs.readFileSync(config, 'utf8'), /^video_refresh_rate = "60.0"$/m)
      assert.match(fs.readFileSync(config, 'utf8'), /^vrr_runloop_enable = "true"$/m)
      assert.match(fs.readFileSync(config, 'utf8'), /^audio_driver = "xaudio"$/m)
      assert.match(fs.readFileSync(config, 'utf8'), /^audio_enable = "true"$/m)
      assert.match(fs.readFileSync(config, 'utf8'), /^audio_mute_enable = "false"$/m)
      assert.match(fs.readFileSync(config, 'utf8'), /^audio_volume = "0.0"$/m)
      assert.match(fs.readFileSync(config, 'utf8'), /^notification_show_autoconfig = "false"$/m)
      assert.match(fs.readFileSync(config, 'utf8'), /^video_osd_widgets = "false"$/m)
      assert.equal(spawned.options.cwd, path.join(profile, 'emulators', 'retroarch'))
      child.emit('exit', 0)
      await wait("document.querySelector('[data-launch-game]')?.disabled===false")
      console.log(
        'PASS: packaged N64 physical check, legal footer, missing-core prompt, Cancel without download/spawn, visible error and retry, download indicator, verified install and automatic launch at the same absolute path'
      )
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
