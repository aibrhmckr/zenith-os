// Real Electron/preload/React with isolated synthetic ROMs, mocked GPU and emulator; no network.
const { app, BrowserWindow } = require('electron')
const cp = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const assert = require('node:assert/strict')
const { coreBinary } = require('./fixtures/core-archive.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-security-ui-'))
const profile = path.join(root, 'profile'),
  runtime = path.join(root, 'emulators/retroarch')
const game = path.join(root, 'games/Test.gba')
fs.mkdirSync(path.dirname(game), { recursive: true })
fs.mkdirSync(path.join(runtime, 'cores'), { recursive: true })
fs.writeFileSync(game, 'synthetic ROM')
fs.writeFileSync(path.join(runtime, 'retroarch.exe'), 'synthetic executable')
fs.writeFileSync(path.join(runtime, 'cores/mgba_libretro.dll'), coreBinary('mgba_libretro.dll'))
app.getAppPath = () => root
app.setPath('userData', profile)
app.disableHardwareAcceleration()
process.env.ZENITH_SECURITY_PROBE = 'not-a-secret-test-sentinel'
let gpu = { gpuDevice: [{ deviceString: 'AMD Radeon 610M', vendorId: 0x1002, active: true }] }
app.getGPUInfo = async () => gpu
globalThis.fetch = async () => new Response('', { status: 404 })
const actions = []
for (const method of [
  'show',
  'hide',
  'restore',
  'focus',
  'setKiosk',
  'setFullScreen',
  'setAlwaysOnTop'
])
  BrowserWindow.prototype[method] = (...args) => actions.push([method, ...args])
let emulator
cp.spawn = (command) => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), { write() {}, end() {}, writable: true })
  child.kill = () => {
    child.killed = true
    child.emit('exit', 0)
  }
  if (command.endsWith('retroarch.exe')) {
    emulator = child
    child.pid = 700001
    setTimeout(() => child.emit('spawn'), 10)
  }
  return child
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timeout = setTimeout(() => {
  console.error('Security/hardware UI timeout')
  app.exit(1)
}, 30000)
app.once('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false)
  win.webContents.once('did-finish-load', async () => {
    const ev = (code) => win.webContents.executeJavaScript(code)
    const wait = async (code) => {
      for (let i = 0; i < 200; i++) {
        if (await ev(code)) return
        await delay(25)
      }
      throw Error('Timeout: ' + code)
    }
    try {
      await wait("!!document.querySelector('[data-settings-trigger]')")
      const prefs = win.webContents.getLastWebPreferences()
      assert.equal(prefs.sandbox, true)
      assert.equal(prefs.contextIsolation, true)
      assert.equal(prefs.nodeIntegration, false)
      assert.deepEqual(
        await ev(
          '({env:typeof window.electron.process.env,invoke:typeof window.electron.ipcRenderer,api:typeof window.electronAPI.getLocalGames})'
        ),
        { env: 'undefined', invoke: 'undefined', api: 'function' }
      )
      const denied = await ev(
        `window.electronAPI.listFiles({kind:'games',path:${JSON.stringify(root)}}).then(r=>r.success===false,()=>true)`
      )
      assert(denied, 'Unapproved parent directory is denied through real IPC')
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.resolve('out/preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      await foreign.loadURL('about:blank')
      assert(
        await foreign.webContents.executeJavaScript(
          'window.electronAPI.getLocalGames().then(r=>r.success===false,()=>true)'
        ),
        'Foreign renderer cannot invoke privileged IPC'
      )
      foreign.destroy()
      await ev("document.querySelector('[data-settings-trigger]').click()")
      await wait("!!document.querySelector('[data-system-page]')")
      await ev("document.querySelector('[data-system-page]').click()")
      await wait(
        "document.querySelector('[data-hardware-status]')?.textContent.includes('Radeon 610M')"
      )
      assert((await ev('window.electronAPI.getHardwareStatus()')).classification === 'fallback')
      gpu = {
        gpuDevice: [{ deviceString: 'NVIDIA GeForce RTX 4060', vendorId: 0x10de, active: true }]
      }
      app.emit('gpu-info-update')
      await wait(
        "document.querySelector('[data-hardware-status]')?.textContent.includes('Dedicated GPU active')"
      )
      await ev("document.querySelector('[data-modal-close]').click()")
      await ev(
        `window.launchResult=null; void window.electronAPI.launchGame(${JSON.stringify(game)},'GBA').then(r=>window.launchResult=r)`
      )
      for (let i = 0; !emulator && i < 100; i++) await delay(20)
      assert(emulator)
      await delay(30)
      emulator.stderr.emit('data', Buffer.from('VK_ERROR_DEVICE_LOST: simulated driver reset'))
      emulator.emit('exit', -1073741819)
      emulator.emit('close', -1073741819)
      await wait('window.launchResult !== null')
      assert.equal((await ev('window.launchResult')).error, 'gpu_driver')
      assert(actions.some(([name]) => name === 'restore'))
      assert.equal(actions.at(-1)[0], 'focus')
      const log = path.join(profile, 'logs/crash-report.log')
      for (let i = 0; !fs.existsSync(log) && i < 100; i++) await delay(20)
      const report = fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse)
        .find((entry) => entry.reason === 'gpu_driver')
      assert.equal(report.codeHex, '0xc0000005')
      assert.equal(report.reason, 'gpu_driver')
      console.log(
        'PASS: sandbox, narrow preload, real IPC denial, GPU UI updates, crash recovery and persisted diagnosis'
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
