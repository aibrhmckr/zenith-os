// Real Main/preload/React with synthetic progress events; no network or binary downloads.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-download-ui-'))
fs.mkdirSync(path.join(root, 'games'))
fs.mkdirSync(path.join(root, 'profile'))
app.getAppPath = () => root
app.setPath('userData', path.join(root, 'profile'))
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = () => {}
globalThis.fetch = async () => new Response('', { status: 404 })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timeout = setTimeout(() => app.exit(1), 30000)
app.once('browser-window-created', (_, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    const run = (code) => window.webContents.executeJavaScript(code)
    const wait = async (code) => {
      for (let i = 0; i < 300; i++) {
        if (await run(code)) return
        await delay(20)
      }
      throw Error('Timeout: ' + code)
    }
    const send = (tasks) => window.webContents.send('downloads:progress', tasks)
    const row = (id) => `document.querySelector('[data-download-task="${id}"]')`
    const open = async () => {
      await run("document.querySelector('[data-downloads-trigger]').click()")
      await wait("document.querySelector('[data-console-modal=downloads][open]') !== null")
    }
    const close = async () => {
      await run(
        "document.querySelector('dialog[open]').dispatchEvent(new CustomEvent('controller-input',{detail:{hit:i=>i===1,move:null,axes:[0,0,0,0],now:performance.now()}}))"
      )
      await wait("!document.querySelector('dialog[open]')")
    }
    try {
      await wait("!!document.querySelector('[data-downloads-trigger]')")
      await delay(200)
      await open()
      assert.equal(await run("document.querySelector('[data-clear-notifications]').disabled"), true)
      assert(
        await run(
          "document.querySelector('[data-no-downloads]').textContent.includes('No new notifications')"
        )
      )
      const failed = {
        id: 'failed',
        name: 'Example',
        kind: 'video',
        status: 'failed',
        error: 'HTTP 403 https://buildbot.libretro.com/core.zip C:\\Code\\zenith\\cores',
        updatedAt: Date.now()
      }
      const queued = {
        id: 'queued',
        name: 'Queued core',
        kind: 'core',
        status: 'queued',
        updatedAt: Date.now()
      }
      const done = {
        id: 'rpcs3',
        name: 'RPCS3',
        kind: 'rpcs3',
        status: 'completed',
        updatedAt: Date.now()
      }
      send([done, failed, queued])
      await wait(`${row('rpcs3')}?.textContent.includes('RPCS3 Update')`)
      assert(
        !(await run("document.querySelector('.download-center').textContent.includes('taskKind_')"))
      )
      assert(!(await run("!!document.querySelector('[data-no-downloads]')")))
      await run(`${row('rpcs3')}.focus()`)
      await wait(`${row('rpcs3')}?.dataset.leaving === 'true'`)
      await wait(`!${row('rpcs3')}`)
      assert(
        await run("document.activeElement.hasAttribute('data-initial-focus')"),
        await run('document.activeElement.outerHTML')
      )
      assert(await run(`!!${row('failed')} && !!${row('queued')}`))
      await close()
      await open()
      assert(!(await run(`!!${row('rpcs3')}`)))

      // A retry during the fade cancels the old removal deadline.
      send([{ ...done, updatedAt: Date.now() - 4100 }])
      await wait(`${row('rpcs3')}?.dataset.leaving === 'true'`)
      send([{ ...done, status: 'active', percent: 20, updatedAt: Date.now() }])
      await wait(`${row('rpcs3')} && !${row('rpcs3')}.dataset.leaving`)
      await delay(400)
      assert(await run(`!!${row('rpcs3')}`))

      const installer = {
        id: 'zenith-update',
        name: 'Zenith OS',
        kind: 'app',
        status: 'completed',
        phase: 'ready-to-install',
        updatedAt: Date.now()
      }
      send([installer, { ...done, updatedAt: Date.now() }, failed])
      await wait(`${row('zenith-update')} !== null`)
      assert.equal(await run("document.querySelectorAll('.download-center button').length"), 0)
      let updateCalls = 0
      ipcMain.removeHandler('software:update')
      ipcMain.handle('software:update', () => {
        updateCalls++
        return { success: true }
      })
      await run(`${row('zenith-update')}.click()`)
      await wait("document.activeElement.hasAttribute('data-software-update')")
      assert.equal(updateCalls, 0, 'Opening an update notification must not start maintenance')
      await run('document.activeElement.click()')
      await wait(
        "[...document.querySelectorAll('[role=status]')].some(el=>el.textContent.includes('Updates started'))"
      )
      assert.equal(updateCalls, 1)
      await close()
      await open()
      send([{ ...done, status: 'active', updatedAt: Date.now() }])
      await wait(`!!${row('rpcs3')}`)
      await run(
        `${row('rpcs3')}.focus();document.querySelector('dialog[open]').dispatchEvent(new CustomEvent('controller-input',{detail:{hit:i=>i===0,move:null,axes:[0,0,0,0],now:performance.now()}}))`
      )
      await wait("document.activeElement.hasAttribute('data-software-update')")
      assert.equal(updateCalls, 1, 'Gamepad A navigates without activating the settings button')
      await close()
      await open()
      send([failed])
      await wait(`!!${row('failed')}`)
      assert.equal(await run("!!document.querySelector('[data-no-downloads]')"), false)
      assert.match(await run(`${row('failed')}.textContent`), /network connection error/)
      assert.doesNotMatch(await run(`${row('failed')}.textContent`), /https:|C:\\|buildbot/)
      // Use the real clear-history IPC; queued/active jobs are covered by service tests.
      await run(
        "document.querySelector('dialog[open]').dispatchEvent(new CustomEvent('controller-input',{detail:{hit:i=>i===2,move:null,axes:[0,0,0,0],now:performance.now()}}))"
      )
      await wait("document.querySelectorAll('[data-download-task]').length===0")
      await close()
      await open()
      assert.equal(await run("document.querySelectorAll('[data-download-task]').length"), 0)
      console.log(
        'PASS: notification fade, focus restore, retries, clean titles, no update actions, mouse/gamepad Settings focus, explicit software-update IPC'
      )
      clearTimeout(timeout)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.error(await run('document.body.innerText'))
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
