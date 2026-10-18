// Real Main/preload/React: synthetic files, no real ROMs, external network or native picker.
const { app, BrowserWindow, dialog, nativeImage } = require('electron')
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-split-browser-'))
const profile = path.join(root, 'profile'),
  desktop = path.join(root, 'Desktop'),
  downloads = path.join(root, 'Downloads')
for (const dir of [
  profile,
  desktop,
  downloads,
  path.join(desktop, 'Empty'),
  path.join(root, 'games')
])
  fs.mkdirSync(dir, { recursive: true })
const png = nativeImage
  .createFromBitmap(Buffer.alloc(64 * 32 * 4, 150), { width: 64, height: 32 })
  .toPNG()
fs.writeFileSync(path.join(desktop, 'Forest.png'), png)
fs.writeFileSync(path.join(desktop, 'Bad.png'), 'not an image')
fs.writeFileSync(path.join(desktop, 'Hidden.exe'), 'not executable')
fs.writeFileSync(path.join(desktop, 'Demo.gba'), 'test game')
fs.mkdirSync(path.join(desktop, 'Summary', 'Nested'), { recursive: true })
fs.writeFileSync(path.join(desktop, 'Summary', 'notes.txt'), Buffer.alloc(1024))
fs.writeFileSync(path.join(desktop, 'Summary', 'Nested', 'more.txt'), Buffer.alloc(2048))
fs.utimesSync(path.join(desktop, 'Forest.png'), new Date('2020-01-02'), new Date('2020-01-02'))
const getPath = app.getPath.bind(app)
app.getPath = (name) => ({ home: root, desktop, downloads })[name] || getPath(name)
app.getAppPath = () => root
app.setPath('userData', profile)
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = () => {}
dialog.showOpenDialog = async () => {
  throw Error('Native picker not allowed')
}
globalThis.fetch = async () => new Response('', { status: 404 })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timeout = setTimeout(() => {
  console.error('Split-view timeout')
  app.exit(1)
}, 60000)
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
    const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click();undefined`)
    const focus = (name) =>
      ev(
        `(()=>{const b=[...document.querySelectorAll('[data-file-entry]')].find(b=>b.dataset.fileName===${JSON.stringify(name)});b.focus();b.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()`
      )
    const pad = async (button, move = null) => {
      await ev(
        `document.querySelector('[data-console-modal=fileBrowser]').dispatchEvent(new CustomEvent('controller-input',{detail:{hit:i=>i===${button},move:${JSON.stringify(move)}}}));undefined`
      )
      await delay(40)
    }
    const key = (key) =>
      ev(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}));undefined`
      )
    try {
      await wait("!!document.querySelector('[data-add-game]')")
      // Local silent WebM fixture exercises the actual browser codec and stream protocol.
      const bytes = await ev(
        `new Promise(resolve=>{const c=document.createElement('canvas');c.width=64;c.height=32;const ctx=c.getContext('2d'),s=c.captureStream(10),parts=[],r=new MediaRecorder(s,{mimeType:'video/webm;codecs=vp8'});r.ondataavailable=e=>parts.push(e.data);r.onstop=async()=>{s.getTracks().forEach(t=>t.stop());resolve(Array.from(new Uint8Array(await new Blob(parts).arrayBuffer())))};r.start();const timer=setInterval(()=>{ctx.fillStyle='#38a2bf';ctx.fillRect(0,0,64,32)},30);setTimeout(()=>{clearInterval(timer);r.stop()},300)})`
      )
      fs.writeFileSync(path.join(desktop, 'Loop.webm'), Buffer.from(bytes))
      await click('[data-settings-trigger]')
      await wait("!!document.querySelector('[data-wallpaper-page]')")
      await click('[data-wallpaper-page]')
      await click('[data-wallpaper-import]')
      await wait("!!document.querySelector('[data-file-location=desktop]')")
      assert.equal(
        await ev("!!document.querySelector('[data-file-location=home]')"),
        false,
        'Broad home browsing is not granted'
      )
      assert.equal(await ev("document.querySelectorAll('[data-file-column]').length"), 3)
      await click('[data-file-location=desktop]')
      await wait('!!document.querySelector(\'[data-file-name="Forest.png"]\')')
      await pad(4)
      assert.equal(
        await ev("document.activeElement.closest('[data-file-column]').dataset.fileColumn"),
        '0'
      )
      await pad(0)
      await wait('!!document.querySelector(\'[data-file-name="Forest.png"]\')')
      assert.equal(await ev('document.activeElement.dataset.fileName'), 'Empty')
      assert.equal(await ev('!!document.querySelector(\'[data-file-name="Hidden.exe"]\')'), false)
      assert.equal(await ev('!!document.querySelector(\'[data-file-name="Demo.gba"]\')'), false)
      assert(
        await ev(
          "document.querySelector('[data-file-breadcrumbs]').textContent.includes('Desktop')"
        )
      )
      await focus('Summary')
      await wait("document.querySelector('[data-folder-items]')?.textContent==='3'")
      assert.equal(await ev("document.querySelector('[data-folder-size]').textContent"), '3 KB')
      assert(
        (await ev("document.querySelector('[data-folder-summary]').textContent")).includes(
          'Summary'
        )
      )
      assert.equal(
        await ev(
          'document.querySelector(\'[data-file-name="Forest.png"] [data-file-size]\').textContent'
        ),
        png.length + ' B'
      )
      assert.equal(
        await ev(
          "document.querySelector('[data-file-name=\"Forest.png\"] time').getAttribute('datetime')"
        ),
        '2020-01-02T00:00:00.000Z'
      )
      assert(
        !(
          await ev('document.querySelector(\'[data-file-name="Forest.png"] time\').textContent')
        ).includes('—')
      )
      if (process.argv.includes('--screenshot')) {
        await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
        await delay(250)
        fs.writeFileSync(
          path.resolve('folder-details-preview.png'),
          (
            await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
          ).toPNG()
        )
      }
      await focus('Empty')
      await wait("document.querySelector('[data-folder-items]')?.textContent==='0'")
      await pad(0)
      await wait("document.querySelectorAll('[data-file-entry]').length===0")
      assert(await ev("document.activeElement.hasAttribute('data-file-up')"))
      await pad(1)
      await wait('!!document.querySelector(\'[data-file-name="Forest.png"]\')')
      await focus('Forest.png')
      await wait("document.querySelector('[data-file-resolution]')?.textContent==='64 × 32'")
      const oldUrl = await ev("document.querySelector('[data-file-preview] img').src")
      await key('ArrowRight')
      assert(await ev("document.activeElement.hasAttribute('data-file-confirm')"))
      await pad(4)
      assert.equal(await ev('document.activeElement.dataset.fileName'), 'Forest.png')
      await pad(4)
      await pad(5)
      assert.equal(
        await ev('document.activeElement.dataset.fileName'),
        'Forest.png',
        'LB/RB restores list row'
      )
      // Layout stays split even at Steam Deck dimensions, with independent list scrolling.
      win.setKiosk(false)
      win.setFullScreen(false)
      win.setSize(1280, 800)
      await delay(150)
      const ratios = await ev(
        `(()=>{const cols=[...document.querySelectorAll('[data-file-column]')].map(e=>e.getBoundingClientRect());const total=cols.reduce((n,r)=>n+r.width,0);return cols.map(r=>r.width/total)})()`
      )
      ratios.forEach((value, i) => assert(Math.abs(value - [0.22, 0.48, 0.3][i]) < 0.01))
      assert.equal(
        await ev("getComputedStyle(document.querySelector('.file-list-scroll')).overflowY"),
        'auto'
      )
      // Navigator polling sends left-stick and D-pad through the same column navigation.
      await ev(
        "window.pad={connected:true,index:0,id:'Test Xbox',buttons:Array.from({length:17},()=>({pressed:false})),axes:[0,0,0,0]};Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.pad]})"
      )
      await delay(100)
      await ev('window.pad.axes[0]=-0.8')
      await wait("document.activeElement.closest('[data-file-column]')?.dataset.fileColumn==='0'")
      await ev('window.pad.axes[0]=0')
      await delay(250)
      await ev('window.pad.buttons[15].pressed=true')
      await wait("document.activeElement.closest('[data-file-column]')?.dataset.fileColumn==='1'")
      await ev('window.pad.buttons[15].pressed=false;window.pad.connected=false')
      await focus('Loop.webm')
      await wait("!!document.querySelector('[data-file-preview] video')")
      await wait("document.querySelector('[data-file-preview] video')?.currentTime > 0")
      assert(
        await ev(
          "(()=>{let v=document.querySelector('[data-file-preview] video');return v.muted&&v.loop&&v.volume===0})()"
        )
      )
      assert(
        [0, 404].includes(
          await ev(`fetch(${JSON.stringify(oldUrl)}).then(r=>r.status).catch(()=>0)`)
        ),
        'Old preview is inaccessible'
      )
      await ev("window.previousVideo=document.querySelector('[data-file-preview] video')")
      await focus('Bad.png')
      await wait(
        "document.querySelector('[data-file-preview]').textContent.includes('Preview unavailable')"
      )
      assert(await ev('window.previousVideo.paused'))
      await focus('Forest.png')
      await wait("!!document.querySelector('[data-file-preview] img')")
      if (process.argv.includes('--screenshot')) {
        const shot = path.resolve('file-browser-preview.png')
        fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG())
        console.log('Screenshot: ' + shot)
      }
      await pad(0)
      await wait(
        "!document.querySelector('[data-file-browser]') && !document.querySelector('[data-wallpaper-import]').disabled"
      )
      assert.equal(
        (await ev('window.electronAPI.getWallpapers()')).items.length,
        6,
        'A directly imports file'
      )
      await click('[data-wallpaper-import]')
      await wait("!!document.querySelector('[data-file-location=desktop]')")
      await click('[data-file-location=desktop]')
      await wait('!!document.querySelector(\'[data-file-name="Forest.png"]\')')
      await focus('Forest.png')
      await key('x')
      await wait(
        "!document.querySelector('[data-file-browser]') && document.querySelectorAll('[data-wallpaper-card]').length===7"
      )
      assert.equal(
        (await ev('window.electronAPI.getWallpapers()')).items.length,
        7,
        'X confirms focused file'
      )
      await click('[data-wallpaper-import]')
      await wait("!!document.querySelector('[data-file-location=desktop]')")
      await click('[data-file-location=desktop]')
      await wait("!!document.querySelector('[data-file-name=Summary]')")
      await click('[data-file-name=Summary]')
      await wait("!!document.querySelector('[data-file-name=Nested]')")
      const crumbs = await ev("document.querySelector('[data-file-breadcrumbs]').textContent")
      assert(crumbs.includes(' › '))
      assert(!crumbs.includes(','))
      await ev(
        `window.testPad={id:'Browser test',index:0,connected:true,axes:[0,0,0,0],buttons:Array.from({length:17},(_,i)=>({pressed:i===5}))};Object.defineProperty(navigator,'getGamepads',{value:()=>[window.testPad]});undefined`
      )
      await wait("document.querySelector('[data-file-browser] footer kbd')?.textContent==='A'")
      await ev('window.testPad.buttons[5].pressed=false')
      assert.deepEqual(
        await ev(
          "[...document.querySelectorAll('[data-file-browser] footer kbd')].map(k=>k.textContent)"
        ),
        ['A', 'B', 'X', 'LB / RB']
      )
      await key('Escape')
      await wait("!document.querySelector('[data-file-browser]')")
      assert.equal((await ev('window.electronAPI.getWallpapers()')).items.length, 7)
      console.log(
        'PASS: split ratios, quick access, breadcrumbs, filters, image resolution, muted video cleanup, LB/RB, stick/D-pad, keyboard, parent/empty directory, A/X import and Escape cancellation'
      )
      clearTimeout(timeout)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.log(await ev('document.body.innerText'))
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
