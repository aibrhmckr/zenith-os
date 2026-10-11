// Real Main/preload/React and release service; fake updater means no network, installer or user-data changes.
const { app, BrowserWindow, ipcMain } = require('electron')
const { EventEmitter } = require('node:events')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-ota-ui-'))
app.getAppPath = () => root
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
for (const method of ['show', 'setKiosk', 'setFullScreen'])
  BrowserWindow.prototype[method] = () => {}
globalThis.fetch = async () => new Response('', { status: 404 })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timer = setTimeout(() => {
  console.error('OTA UI timeout')
  app.exit(1)
}, 35000)
app.once('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', async () => {
    const ev = (code) => win.webContents.executeJavaScript(code)
    const wait = async (code) => {
      for (let i = 0; i < 250; i++) {
        if (await ev(code)) return
        await delay(20)
      }
      throw Error('Timeout: ' + code)
    }
    const click = (selector) =>
      ev(`document.querySelector(${JSON.stringify(selector)}).click();undefined`)
    const pad = (button) =>
      ev(
        `document.querySelector('dialog[open]').dispatchEvent(new CustomEvent('controller-input', {detail:{hit:i=>i===${button},move:null,axes:[0,0,0,0],now:performance.now()}}));undefined`
      )
    const open = async () => {
      await click('[data-settings-trigger]')
      await wait("!!document.querySelector('[data-software-update]')")
    }
    const close = async () => {
      await pad(1)
      await wait("!document.querySelector('dialog[open]')")
    }
    try {
      await wait("!!document.querySelector('[data-settings-trigger]')")
      await open()
      await wait(
        "document.querySelector('[data-app-update-status]')?.dataset.appUpdateStatus==='developer'"
      )
      assert.equal((await ev('window.electronAPI.checkUpdates()')).developer, true)
      assert.equal((await ev('window.electronAPI.quitAndInstallUpdate()')).success, false)
      await close()

      const { createApplicationUpdater } =
        await import('../src/main/services/applicationUpdater.js')
      const updater = new EventEmitter(),
        installs = []
      let finish,
        pendingCheck,
        checks = 0,
        idle = true
      updater.checkForUpdates = async () => {
        checks++
        updater.emit('checking-for-update')
        return {
          downloadPromise: new Promise((resolve) => {
            finish = resolve
          })
        }
      }
      updater.quitAndInstall = (...args) => installs.push(args)
      const service = createApplicationUpdater({
        updater,
        enabled: true,
        app: { isPackaged: true },
        canInstall: () => idle,
        downloads: { report() {} },
        publish: (channel, state) => win.webContents.send(channel, state)
      })
      for (const name of ['app-update:status', 'software:update', 'app-update:quit-and-install'])
        ipcMain.removeHandler(name)
      ipcMain.handle('app-update:status', () => service.snapshot())
      ipcMain.handle('software:update', () => {
        pendingCheck = service.check()
        return { success: true }
      })
      ipcMain.handle('app-update:quit-and-install', (_, options) =>
        service.install(options?.confirmed)
      )
      await open()
      await wait(
        "document.querySelector('[data-app-update-status]')?.dataset.appUpdateStatus==='idle'"
      )
      await ev("document.querySelector('[data-software-update]').focus();undefined")
      await pad(0)
      await wait(
        "document.querySelector('[data-app-update-status]')?.dataset.appUpdateStatus==='checking'"
      )
      updater.emit('update-available', {
        version: '1.0.1',
        releaseDate: '2026-10-11',
        releaseNotes: 'Test'
      })
      updater.emit('download-progress', {
        percent: 78,
        transferred: 78,
        total: 100,
        bytesPerSecond: 1024
      })
      await wait("document.querySelector('[data-app-update-status] progress')?.value===78")
      assert(
        (await ev("document.querySelector('[data-app-update-status]').textContent")).includes(
          'v1.0.1'
        )
      )
      await click('[data-software-update]')
      assert.equal(checks, 1, 'An in-progress download cannot be started again')
      await close()
      updater.emit('update-downloaded', { version: '1.0.1' })
      finish()
      await pendingCheck
      assert.deepEqual(installs, [], 'Background completion cannot force restart')
      await ev('window.electronAPI.clearDownloadHistory()')
      await open()
      await wait(
        "document.querySelector('[data-software-update] strong')?.textContent==='Update Ready'"
      )
      assert(
        (await ev("document.querySelector('[data-software-update]').textContent")).includes(
          'Restart & install'
        )
      )
      idle = false
      await click('[data-software-update]')
      await wait("!!document.querySelector('[role=alert]')")
      assert.deepEqual(installs, [], 'Running sessions/maintenance block restart in Main')
      idle = true
      await ev("document.querySelector('[data-software-update]').focus();undefined")
      await pad(0)
      await wait("document.querySelector('[role=status]')?.textContent.includes('Restarting')")
      assert.deepEqual(installs, [[false, true]])
      await close()

      // A late snapshot must not overwrite a newer release event.
      let releaseSnapshot,
        snapshotRequested = false
      ipcMain.removeHandler('app-update:status')
      ipcMain.handle('app-update:status', () => {
        snapshotRequested = true
        return new Promise((resolve) => {
          releaseSnapshot = resolve
        })
      })
      await open()
      for (let i = 0; i < 100 && !snapshotRequested; i++) await delay(20)
      assert(snapshotRequested)
      updater.emit('checking-for-update')
      updater.emit('update-not-available')
      await wait(
        "document.querySelector('[data-app-update-status]')?.dataset.appUpdateStatus==='up-to-date'"
      )
      releaseSnapshot({ status: 'idle', ready: false })
      await delay(100)
      assert.equal(
        await ev("document.querySelector('[data-app-update-status]').dataset.appUpdateStatus"),
        'up-to-date'
      )
      updater.emit(
        'error',
        Error('HTTP 503 https://example.invalid/private C:\\private\\update.exe')
      )
      await wait(
        "document.querySelector('[data-app-update-status]')?.dataset.appUpdateStatus==='error'"
      )
      const errorText = await ev("document.querySelector('[data-app-update-status]').textContent")
      assert(!errorText.includes('https:') && !errorText.includes('C:'))
      assert(errorText.length > 0)
      // Public event bridge exposes payloads only and removes all six subscriptions.
      await ev(
        'window.otaEvents=[];window.stopOta=window.electronAPI.onAppUpdate(value=>window.otaEvents.push(value));undefined'
      )
      updater.emit('update-not-available')
      await wait('window.otaEvents.length===1')
      await ev('window.stopOta();undefined')
      updater.emit('update-not-available')
      await delay(60)
      assert.equal(await ev('window.otaEvents.length'), 1)
      console.log(
        'PASS: developer guard, live OTA progress, deferred restart, ready after history clear/reopen, gamepad activation, busy guard, snapshot race and event cleanup'
      )
      clearTimeout(timer)
      app.exit(0)
    } catch (error) {
      console.error(error)
      clearTimeout(timer)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
