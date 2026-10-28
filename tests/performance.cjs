// Real Electron renderer with an isolated 1,000-game library and simulated controller.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-large-ui-'))
fs.mkdirSync(path.join(root, 'games'))
for (let i = 0; i < 1000; i++)
  fs.writeFileSync(
    path.join(root, 'games', `Fixture ${String(i).padStart(4, '0')}.nds`),
    'synthetic'
  )
app.getAppPath = () => root
app.setPath('userData', path.join(root, 'profile'))
fs.mkdirSync(path.join(root, 'profile'), { recursive: true })
fs.writeFileSync(
  path.join(root, 'profile', 'zenith-preferences.json'),
  JSON.stringify({
    media: {
      downloadCovers: false,
      downloadBackgrounds: false,
      downloadVideos: false,
      downloadAudio: false
    }
  })
)
BrowserWindow.prototype.show = () => {}
globalThis.fetch = async () => new Response('', { status: 404 })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timeout = setTimeout(() => {
  console.error('Large-library UI timeout')
  app.exit(1)
}, 90000)
app.once('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const wait = async (code) => {
      for (let i = 0; i < 400; i++) {
        if (await evaluate(code)) return
        await sleep(25)
      }
      throw Error(`Timeout: ${code}`)
    }
    try {
      await wait("document.querySelector('[data-library-size]')?.dataset.librarySize==='1000'")
      const initial = await evaluate("document.querySelectorAll('[data-game-card]').length")
      assert(initial < 200, 'Large libraries must not mount every card')
      await evaluate(
        `window.padReads=0;window.pad={id:'Performance controller',index:0,connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false}))};Object.defineProperty(navigator,'getGamepads',{value:()=>{window.padReads++;return [window.pad]}});undefined`
      )
      for (let i = 0; i < 15; i++) {
        const before = await evaluate('window.padReads')
        await evaluate('window.pad.buttons[13].pressed=true')
        await wait(`window.padReads>${before}`)
        await sleep(35)
        const after = await evaluate('window.padReads')
        await evaluate('window.pad.buttons[13].pressed=false')
        await wait(`window.padReads>${after}`)
      }
      const selected = await evaluate(
        "document.querySelector('[data-game-card][aria-pressed=true]')?.getAttribute('aria-label')"
      )
      assert(selected && selected !== 'Fixture 0000', 'Down navigation crosses virtual rows')
      await wait("document.querySelector('[data-library-size]').scrollTop>0")
      assert(await evaluate("document.querySelectorAll('[data-game-card]').length<300"))
      // Mouse scrolling can visit rows far from controller focus without an empty shelf.
      await evaluate(
        "document.querySelector('[data-library-size]').scrollTo({top:12000,behavior:'instant'})"
      )
      await wait(
        "[...document.querySelectorAll('[data-game-card]')].some(card=>parseInt(card.style.gridRowStart)>45)"
      )
      // Filtering shrinks the virtual list and preserves a valid selected record.
      await evaluate(
        `{const input=document.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Fixture 099');input.dispatchEvent(new Event('input',{bubbles:true}));}`
      )
      await wait("document.querySelector('[data-library-size]')?.dataset.librarySize==='10'")
      assert.equal(await evaluate("document.querySelectorAll('[data-game-card]').length"), 10)
      assert(await evaluate("!!document.querySelector('[data-game-card][aria-pressed=true]')"))
      console.log(
        'PASS: 1,000-game bounded DOM, controller row navigation, distant mouse scrolling, filtering and focus'
      )
      console.log(
        JSON.stringify({
          initialMountedCards: initial,
          electron: process.versions.electron,
          gpu: (await app.getGPUInfo('basic')).gpuDevice
        })
      )
      app.once('will-quit', () => {
        try {
          assert(
            Array.isArray(
              JSON.parse(fs.readFileSync(path.join(root, 'profile', 'downloads.json'), 'utf8'))
            )
          )
          assert.equal(
            Object.keys(
              JSON.parse(fs.readFileSync(path.join(root, 'profile', 'games.json'), 'utf8')).games
            ).length,
            1000
          )
          console.log('PASS: normal application quit awaits batched persistence')
          clearTimeout(timeout)
        } catch (error) {
          console.error(error)
          app.exit(1)
        }
      })
      app.quit()
    } catch (error) {
      console.error(error)
      console.log(
        await evaluate(
          `JSON.stringify({selected:document.querySelector('[data-game-card][aria-pressed=true]')?.outerHTML.slice(0,400),grid:document.querySelector('[data-library-size]')?.getAttribute('style'),height:document.querySelector('[data-library-size]')?.clientHeight,scrollHeight:document.querySelector('[data-library-size]')?.scrollHeight,scrollTop:document.querySelector('[data-library-size]')?.scrollTop})`
        )
      )
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
