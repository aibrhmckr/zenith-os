// Run through `npm run dev -- --entry tests/dev-renderer.cjs` against the real Vite server.
// Isolate user data and ROMs; never operate on the user's library or launch an emulator.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-dev-renderer-'))
app.getAppPath = () => root
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
for (const method of ['show', 'setKiosk', 'setFullScreen'])
  BrowserWindow.prototype[method] = () => {}
globalThis.fetch = async () => new Response('', { status: 404 })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timeout = setTimeout(() => {
  console.error('FAIL: development renderer timeout')
  app.exit(1)
}, 30000)
app.once('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false)
  const errors = []
  win.webContents.on('console-message', (details) => {
    if (['warning', 'error'].includes(details.level)) {
      errors.push(details.message)
      console.error('[renderer]', details.message)
    }
  })
  win.webContents.once('did-finish-load', async () => {
    try {
      assert(
        app.commandLine.hasSwitch('disable-http-cache'),
        'Vite loads must bypass persistent HTTP cache'
      )
      assert.equal(
        new URL(win.webContents.getURL()).origin,
        new URL(process.env.ELECTRON_RENDERER_URL).origin
      )
      const evaluate = (code) => win.webContents.executeJavaScript(code)
      for (let i = 0; i < 160; i++) {
        if (await evaluate("!!document.querySelector('[data-action-dock]')")) break
        await delay(50)
      }
      const state = await evaluate(
        "({type:document.contentType,root:!!document.querySelector('#root .zenith-shell'),dock:!!document.querySelector('[data-action-dock]'),body:document.body.innerText.slice(0,200),api:typeof window.electronAPI.getLocalGames})"
      )
      console.log('Dev document:', JSON.stringify(state))
      assert.equal(state.type, 'text/html')
      assert.equal(state.root, true, 'React must mount inside #root')
      assert.equal(state.dock, true)
      assert.equal(state.api, 'function', 'Preload remains available')
      assert(!state.body.includes('HTTP/1.1'), 'No raw HTTP stream in document')
      const modules =
        await evaluate(`Promise.all(['/src/main.jsx', '/@vite/client'].map(async url => {
        const response = await fetch(url)
        return { status: response.status, type: response.headers.get('content-type'), text: await response.text() }
      }))`)
      for (const module of modules) {
        assert.equal(module.status, 200)
        assert.match(module.type, /javascript/)
        assert(!module.text.includes('HTTP/1.1 200 OK'))
      }
      await evaluate("localStorage.setItem('dev-renderer-probe', 'preserved')")
      await new Promise((resolve) => {
        win.webContents.once('did-finish-load', resolve)
        win.webContents.reload()
      })
      for (let i = 0; i < 160; i++) {
        if (await evaluate("!!document.querySelector('#root .zenith-shell')")) break
        await delay(50)
      }
      assert(
        await evaluate("!!document.querySelector('#root .zenith-shell')"),
        'React remounts after reload'
      )
      assert.equal(await evaluate("localStorage.getItem('dev-renderer-probe')"), 'preserved')
      assert(
        !errors.some((message) => /preamble|Content Security Policy|SyntaxError/.test(message)),
        errors.join('\n')
      )
      console.log('PASS: Vite HTML/JS, React mount, dock, preload, reload and retained preferences')
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
