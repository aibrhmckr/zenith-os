// Real renderer/preload and IPC; isolated status fixtures, no emulator or firmware downloads.
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-system-status-'))
app.getAppPath = () => root
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
for (const method of ['show', 'setKiosk', 'setFullScreen'])
  BrowserWindow.prototype[method] = () => {}
dialog.showOpenDialog = async () => {
  throw Error('No native picker expected')
}
globalThis.fetch = async () => new Response('', { status: 404 })
const runtime = {
  ready: true,
  executableReady: true,
  hostPlatform: 'win32',
  installedVersion: 'v0.0.38-12345',
  executable: path.join(root, 'emulators/rpcs3/rpcs3.exe'),
  firmware: {
    ready: true,
    version: '04.9300',
    directory: path.join(root, 'emulators/rpcs3/portable/dev_flash')
  }
}
let systems = [
  { platform: 'PS3', emulator: 'RPCS3', runtime },
  {
    platform: 'PS2',
    core: 'pcsx2_libretro.dll',
    corePath: path.join(root, 'cores/pcsx2_libretro.dll'),
    bios: { required: true, ready: true }
  },
  {
    platform: 'NDS',
    core: null,
    expectedCore: 'melonds_libretro.dll',
    coreDirectory: path.join(root, 'cores'),
    bios: { required: false, ready: true }
  },
  {
    platform: 'GBA',
    core: 'mgba_libretro.dll',
    corePath: path.join(root, 'cores/mgba_libretro.dll'),
    bios: { required: false, ready: true }
  },
  {
    platform: 'Atari 2600',
    core: 'stella_libretro.dll',
    bios: { required: false, ready: true }
  },
  {
    platform: 'NES',
    core: 'mesen_libretro.dll',
    bios: { required: false, ready: true }
  }
]
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timer = setTimeout(() => {
  console.error('System status UI timeout')
  app.exit(1)
}, 45000)
app.once('browser-window-created', (_, win) => {
  win.setSize(1280, 900)
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
    const pad = async (move, button = -1) => {
      await ev(
        `document.querySelector('[data-console-modal=systems]').dispatchEvent(new CustomEvent('controller-input',{detail:{move:${JSON.stringify(move)},hit:i=>i===${button},axes:[0,0,0,0],now:performance.now()}}));undefined`
      )
      await delay(30)
    }
    const focus = async (selector) => {
      await ev(
        `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();el.dispatchEvent(new FocusEvent('focusin',{bubbles:true}))})()`
      )
    }
    try {
      ipcMain.removeHandler('get-system-status')
      ipcMain.handle('get-system-status', () => systems)
      await wait("!!document.querySelector('[data-add-game]')")
      await click('[data-settings-trigger]')
      await wait("!!document.querySelector('[data-system-page]')")
      await click('[data-system-page]')
      await wait("document.querySelectorAll('[data-status-card]').length === 6")
      const text = await ev("document.querySelector('[data-console-modal=systems]').innerText")
      for (const label of [
        'PlayStation 3',
        'PlayStation 2',
        'Nintendo DS',
        'RPCS3 · v0.0.38-12345',
        'PCSX2 · Libretro',
        'melonDS · Libretro'
      ])
        assert(text.includes(label), label)
      assert(!text.includes(root), 'Raw paths hidden by default')
      assert(!text.includes('RPCS3 and PS3 firmware'), 'No long setup paragraph')
      assert.equal(await ev("document.querySelectorAll('[data-status-card] svg').length"), 6)
      assert.equal(await ev("document.querySelectorAll('[data-status-details]').length"), 0)
      assert.equal(
        await ev(
          "document.querySelector('[data-status-card=NDS] .system-status-badge').dataset.ready"
        ),
        'false'
      )
      const geometry = await ev(
        `(()=>{const r=[...document.querySelectorAll('[data-rpcs3-actions] button')].map(b=>b.getBoundingClientRect());return r.map(b=>({x:b.x,y:b.y,w:b.width,h:b.height}))})()`
      )
      assert.equal(geometry.length, 4)
      assert.equal(geometry[0].y, geometry[1].y)
      assert.equal(geometry[2].y, geometry[3].y)
      assert(geometry[2].y > geometry[0].y)
      assert(geometry.every((r) => Math.abs(r.w - geometry[0].w) < 1))
      const heights = await ev(
        "[...document.querySelectorAll('[data-status-card]')].map(b=>b.getBoundingClientRect().height)"
      )
      assert(Math.max(...heights) - Math.min(...heights) < 1, 'Uniform card heights')
      await focus('[data-rpcs3-refresh]')
      await pad('right')
      assert.equal(
        await ev("document.querySelector('[data-rpcs3-firmware]').dataset.controllerFocused"),
        'true'
      )
      await pad('down')
      assert.equal(
        await ev("document.querySelector('[data-rpcs3-folder]').dataset.controllerFocused"),
        'true'
      )
      await ev(
        "document.querySelector('[data-rpcs3-folder]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));undefined"
      )
      assert.equal(
        await ev("document.querySelector('[data-rpcs3-package]').dataset.controllerFocused"),
        'true'
      )
      await focus('[data-rpcs3-folder]')
      await pad('right')
      assert.equal(
        await ev("document.activeElement.closest('[data-status-card]').dataset.statusCard"),
        'PS2',
        'Right edge crosses into the neighboring card'
      )
      await pad('left')
      assert.equal(
        await ev("document.activeElement.closest('[data-status-card]').dataset.statusCard"),
        'PS3',
        'Left edge returns to the neighboring card'
      )
      await focus('[data-rpcs3-folder]')
      await pad('down')
      assert.equal(
        await ev(
          "document.querySelector('[data-status-card=PS3] [data-status-details-toggle]').dataset.controllerFocused"
        ),
        'true',
        'Last action always enters its own Details'
      )
      await pad('right')
      assert.equal(
        await ev("document.activeElement.closest('[data-status-card]').dataset.statusCard"),
        'PS2'
      )
      assert(
        await ev("document.activeElement.hasAttribute('data-status-details-toggle')"),
        'Details crosses to Details'
      )
      await pad('right')
      assert.equal(
        await ev("document.activeElement.closest('[data-status-card]').dataset.statusCard"),
        'PS2',
        'Outer right edge stays bounded'
      )
      await ev(
        "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));undefined"
      )
      assert.equal(
        await ev("document.activeElement.closest('[data-status-card]').dataset.statusCard"),
        'PS3'
      )
      await pad('down')
      assert.equal(
        await ev(
          "document.querySelector('[data-status-card=NDS] button').dataset.controllerFocused"
        ),
        'true',
        'Details leads to the first action in the next row, same column'
      )
      await pad('up')
      assert.equal(
        await ev(
          "document.querySelector('[data-status-card=PS3] [data-status-details-toggle]').dataset.controllerFocused"
        ),
        'true'
      )
      assert(
        await ev(
          "document.querySelector('[data-status-details-toggle]').getBoundingClientRect().height >= 36"
        )
      )
      await focus('[data-status-card="Atari 2600"] [data-status-details-toggle]')
      await pad('right')
      assert.equal(
        await ev("document.activeElement.closest('[data-status-card]').dataset.statusCard"),
        'NES',
        'Bottom-row Details crosses right'
      )
      await delay(500)
      assert(
        await ev(
          "(()=>{const a=document.activeElement.getBoundingClientRect(),d=document.querySelector('[data-console-modal=systems]').getBoundingClientRect();return a.top>=d.top && a.bottom<=d.bottom})()"
        ),
        'Bottom-row Details stays visible after scrolling'
      )
      await pad('left')
      assert.equal(
        await ev("document.activeElement.closest('[data-status-card]').dataset.statusCard"),
        'Atari 2600',
        'Bottom-row Details crosses left'
      )
      await focus('[data-status-card=PS3] [data-status-details-toggle]')
      await pad(null, 0)
      await wait("!!document.querySelector('[data-status-card=PS3] [data-status-details]')")
      assert(
        (
          await ev(
            "document.querySelector('[data-status-card=PS3] [data-status-details]').innerText"
          )
        ).includes(runtime.executable)
      )
      await click('[data-status-card=PS3] [data-status-details-toggle]')
      await wait("!document.querySelector('[data-status-details]')")
      systems = systems.map((s) =>
        s.platform === 'PS2'
          ? { ...s, core: null, corePath: null, expectedCore: 'pcsx2_libretro.dll' }
          : s
      )
      await wait(
        "document.querySelector('[data-status-card=PS2] .system-status-badge').dataset.ready === 'false'"
      )
      assert(await ev("!!document.querySelector('[data-install-core=PS2]')"))
      if (process.argv.includes('--screenshot'))
        fs.writeFileSync(
          path.resolve('system-status-preview.png'),
          (await win.webContents.capturePage()).toPNG()
        )
      win.webContents.enableDeviceEmulation({
        screenPosition: 'desktop',
        screenSize: { width: 800, height: 900 },
        viewSize: { width: 800, height: 900 },
        deviceScaleFactor: 1,
        scale: 1
      })
      await delay(100)
      assert.equal(
        await ev(
          "getComputedStyle(document.querySelector('.system-status-list')).gridTemplateColumns.split(' ').length"
        ),
        1
      )
      await focus('[data-status-card=PS3] [data-status-details-toggle]')
      await pad('right')
      assert.equal(
        await ev("document.activeElement.closest('[data-status-card]').dataset.statusCard"),
        'PS3',
        'One-column layout does not jump sideways'
      )
      await pad('down')
      assert.equal(
        await ev("document.activeElement.closest('[data-status-card]').dataset.statusCard"),
        'PS2',
        'One-column layout moves down to the following card'
      )
      await pad(null, 1)
      await wait("!!document.querySelector('[data-console-modal=settings]')")
      console.log(
        'PASS: friendly names/version, hidden paths/details, icons, uniform cards, responsive layout, 2x2 actions, D-pad/keyboard/A/B and live missing status'
      )
      clearTimeout(timer)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.log(await ev('document.body.innerText'))
      clearTimeout(timer)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
