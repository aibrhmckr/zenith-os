// Real packaged-mode Main/IPC/window; file locks are deterministic test doubles.
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-runtime-startup-'))
const resources = path.join(root, 'resources')
const source = path.join(resources, 'emulators', 'retroarch')
const critical = process.argv.includes('--critical')
const name = process.platform === 'win32' ? 'retroarch.exe' : 'retroarch'
fs.mkdirSync(path.join(source, 'autoconfig'), { recursive: true })
fs.mkdirSync(path.join(root, 'games'), { recursive: true })
fs.mkdirSync(path.join(root, 'profile', 'games'), { recursive: true })
fs.writeFileSync(path.join(root, 'games', 'Fixture.a26'), 'synthetic')
fs.writeFileSync(path.join(root, 'profile', 'games', 'Fixture.a26'), 'synthetic')
fs.writeFileSync(path.join(source, name), 'synthetic executable')
fs.writeFileSync(path.join(source, 'autoconfig', '8BitDo_8BitDo_Lite_2.cfg'), 'fixture config')
if (critical) fs.writeFileSync(path.join(source, 'dependency.dll'), 'fixture dependency')
Object.defineProperty(app, 'isPackaged', { value: true })
Object.defineProperty(process, 'resourcesPath', { value: resources })
process.env.PORTABLE_EXECUTABLE_DIR = root
app.getAppPath = () => root
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = () => {}
globalThis.fetch = async () => new Response('', { status: 404 })
const dialogs = []
dialog.showMessageBox = async (...args) => {
  dialogs.push(args.at(-1))
  return { response: 0 }
}
let release,
  reachedCopy = false
const gate = new Promise((resolve) => {
  release = resolve
})
const originalCopy = fs.promises.copyFile
fs.promises.copyFile = async (from, ...args) => {
  reachedCopy = true
  await gate // Remains pending until the actual renderer has loaded.
  if (from.endsWith('.cfg') || (critical && from.endsWith('.dll'))) {
    throw Object.assign(Error('simulated file lock'), { code: critical ? 'EPERM' : 'EBUSY' })
  }
  return originalCopy(from, ...args)
}
const timeout = setTimeout(() => {
  console.error('Startup test timeout')
  app.exit(1)
}, 20000)
app.on('will-quit', () => {
  throw Error('Startup must not call app.quit()')
})
app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const evaluate = (code) => win.webContents.executeJavaScript(code)
      assert.equal(win.isFullScreen(), true, 'Dashboard starts in fullscreen console mode')
      assert.equal(win.isKiosk(), true, 'Dashboard starts in kiosk mode')
      assert.equal(win.autoHideMenuBar, true, 'Native menu bar stays hidden by default')
      assert.deepEqual(
        win.getContentBounds(),
        win.getBounds(),
        'Frameless window has no native title bar or borders around its content'
      )
      for (let i = 0; i < 100 && !reachedCopy; i++) await new Promise((r) => setTimeout(r, 10))
      assert(reachedCopy, 'Window loads while runtime copy is still pending')
      assert.equal(dialogs.length, 0, 'No blocking initialization dialog')
      const games = await evaluate('window.electronAPI.getLocalGames()')
      assert.equal(games.length, 1, 'Library IPC works before runtime is ready')
      await evaluate(
        `window.launchResult = null; void window.electronAPI.launchGame(${JSON.stringify(games[0].path)}, 'Atari 2600').then(r => window.launchResult = r); undefined`
      )
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(await evaluate('window.launchResult'), null, 'Launch waits for preparation')
      release()
      let result
      for (let i = 0; i < 200; i++) {
        result = await evaluate('window.launchResult')
        if (result) break
        await new Promise((r) => setTimeout(r, 10))
      }
      assert(result)
      assert.match(
        result.error,
        critical ? /preparation failed.*simulated file lock/ : /missing_core/
      )
      assert(!win.isDestroyed(), 'Window stays usable after the failure')
      assert.equal(dialogs.length, critical ? 1 : 0)
      console.log(
        'PASS: packaged window/IPC opens before copying; launch waits; ' +
          (critical ? 'critical failure keeps window alive' : 'locked cfg is skipped')
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
// Electron owns open Chromium profile files until process shutdown. The temporary
// fixture must not be recursively removed synchronously from a process exit hook.
require(process.env.ZENITH_TEST_MAIN || '../out/main/index.js')
