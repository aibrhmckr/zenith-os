// Real Electron picker/IPC/persistence and React gallery. Generated media only; no external downloads.
const { app, BrowserWindow, dialog, nativeImage } = require('electron')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-wallpaper-ui-'))
const profile = path.join(root, 'profile')
fs.mkdirSync(path.join(root, 'games'))
fs.mkdirSync(profile)
const png = nativeImage
  .createFromBitmap(Buffer.from([30, 50, 80, 255]), { width: 1, height: 1 })
  .toPNG()
fs.writeFileSync(path.join(root, 'games', 'Demo.gba'), 'synthetic game')
fs.writeFileSync(path.join(root, 'games', 'Demo.png'), png)
const image = path.join(root, 'My wallpaper.png')
fs.writeFileSync(image, png)
app.getAppPath = () => root
const originalGetPath = app.getPath.bind(app)
app.getPath = (name) => (['desktop', 'downloads'].includes(name) ? root : originalGetPath(name))
app.setPath('userData', profile)
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = () => {}
globalThis.fetch = async () => new Response('', { status: 404 })
let chosen = null
dialog.showOpenDialog = async () => {
  throw Error('Native wallpaper picker must not be used')
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timeout = setTimeout(() => {
  console.error('Wallpaper UI timeout')
  app.exit(1)
}, 45000)
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
    const pad = async (button, move = null) => {
      await run(
        `document.querySelector('dialog[open]').dispatchEvent(new CustomEvent('controller-input',{detail:{hit:i=>i===${button},move:${JSON.stringify(move)},axes:[0,0,0,0],now:performance.now()}}))`
      )
      await delay(30)
    }
    const open = async () => {
      await run("document.querySelector('[data-settings-trigger]').click()")
      await wait("!!document.querySelector('[data-wallpaper-page]')")
      await run("document.querySelector('[data-wallpaper-page]').click()")
      await wait("!!document.querySelector('[data-console-modal=wallpapers][open]')")
    }
    const importWallpaper = async () => {
      await run("document.querySelector('[data-wallpaper-import]').click()")
      await wait("!!document.querySelector('[data-file-location=desktop]')")
      await run("document.querySelector('[data-file-location=desktop]').click()")
      await wait("!!document.querySelector('[data-file-browser] [data-file-entry]')")
      if (!chosen) {
        await run(
          "document.querySelector('[data-console-modal=fileBrowser] [data-modal-close]').click()"
        )
      } else {
        await wait(
          `[...document.querySelectorAll('[data-file-entry]')].some(b=>b.dataset.fileName===${JSON.stringify(path.basename(chosen))})`
        )
        await run(
          `(()=>{const b=[...document.querySelectorAll('[data-file-entry]')].find(b=>b.dataset.fileName===${JSON.stringify(path.basename(chosen))});b.focus();b.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()`
        )

        await wait("!document.querySelector('[data-file-confirm]').disabled")
        await run(
          "document.querySelector('[data-console-modal=fileBrowser]').dispatchEvent(new CustomEvent('controller-input',{detail:{hit:i=>i===2,move:null}}))"
        )
      }
      await wait("!document.querySelector('[data-file-browser]')")
    }
    try {
      await wait(
        "!!document.querySelector('img.hero-fixed-image') && !!document.querySelector('[data-game-card]')"
      )
      await open()
      assert.equal(await run("document.querySelectorAll('[data-wallpaper-card]').length"), 5)
      await wait(
        "document.querySelectorAll('.wallpaper-preview-window > .wallpaper-theme').length === 5"
      )
      const themePreviews =
        await run(`Array.from(document.querySelectorAll('.wallpaper-preview-window > .wallpaper-theme'), theme => {
        const rect = theme.getBoundingClientRect(), parent = theme.parentElement.getBoundingClientRect();
        return { id: theme.className, height: rect.height, width: rect.width,
          parentHeight: parent.height, background: getComputedStyle(theme).backgroundImage,
          animated: theme.dataset.animated };
      })`)
      for (const preview of themePreviews) {
        assert(preview.height > 50 && preview.width > 100, preview.id + ' has a visible canvas')
        assert(
          Math.abs(preview.height - preview.parentHeight) < 1,
          preview.id + ' fills its thumbnail'
        )
        assert.equal(preview.animated, 'false', 'Gallery themes stay static to save GPU work')
        if (!preview.id.includes('luminescent-glade')) assert.notEqual(preview.background, 'none')
      }
      assert(await run("document.activeElement.hasAttribute('data-wallpaper-only')"))
      assert(
        await run("document.querySelector('dialog').getBoundingClientRect().height === innerHeight")
      )
      await pad(-1, 'down')
      await pad(-1, 'right')
      assert.equal(await run('document.activeElement.dataset.wallpaperCard'), 'deep-space')
      const cardGeometry = await run(
        "(()=>{const b=document.querySelector('[data-wallpaper-card=deep-space]');return [b.offsetTop,b.offsetHeight]})()"
      )
      await pad(0)
      await wait(
        "document.querySelector('[data-wallpaper-card=deep-space]').getAttribute('aria-pressed') === 'true'"
      )
      assert.deepEqual(
        await run(
          "(()=>{const b=document.querySelector('[data-wallpaper-card=deep-space]');return [b.offsetTop,b.offsetHeight]})()"
        ),
        cardGeometry,
        'Selection badge and status do not resize or move cards'
      )
      await run(
        "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))"
      )
      assert.equal(await run('document.activeElement.dataset.wallpaperCard'), 'retro-grid')
      await run(
        "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"
      )
      await wait(
        "document.querySelector('[data-wallpaper-card=retro-grid]').getAttribute('aria-pressed') === 'true'"
      )
      assert(
        await run("!!document.querySelector('img.hero-fixed-image')"),
        'Default mode retains game artwork'
      )
      await run("document.querySelector('[data-wallpaper-only]').focus()")
      await pad(0)
      await wait(
        "!document.querySelector('img.hero-fixed-image') && document.querySelector('[data-wallpaper-only]').getAttribute('aria-checked') === 'true'"
      )
      assert(!(await run("document.querySelector('video.hero-fixed-image').hasAttribute('src')")))
      await pad(1)
      await wait("!!document.querySelector('[data-console-modal=settings]')")
      assert(await run("document.querySelector('[data-audio-setting=previewSound]').disabled"))
      assert.equal(
        await run(
          "getComputedStyle(document.querySelector('[data-audio-setting=previewSound]')).opacity"
        ),
        '0.5'
      )
      assert(await run("!!document.querySelector('#wallpaper-audio-hint')"))
      await pad(1)
      await wait("!document.querySelector('dialog[open]')")
      assert.equal(
        await run(
          'document.querySelector("[data-wallpaper-background]").dataset.wallpaperBackground'
        ),
        'retro-grid'
      )

      await open()
      await importWallpaper()
      await delay(80)
      assert.equal(
        await run("document.querySelectorAll('[data-wallpaper-card]').length"),
        5,
        'Cancel creates nothing'
      )
      chosen = image
      await importWallpaper()
      await wait("document.querySelectorAll('[data-wallpaper-card]').length === 6")
      const state = await run('window.electronAPI.getWallpapers()'),
        id = state.items.at(-1).id
      fs.unlinkSync(image)
      assert(fs.existsSync(path.join(profile, 'wallpapers', id)))
      await run(`document.querySelector('[data-wallpaper-card="${id}"]').click()`)
      await wait("!!document.querySelector('.wallpaper-background img')")
      assert((await run('window.electronAPI.getWallpapers()')).onlyCustom)
      const bad = path.join(root, 'Invalid.png')
      fs.writeFileSync(bad, 'not an image')
      chosen = bad
      await importWallpaper()
      await wait("!!document.querySelector('[data-wallpaper-gallery] [role=alert]')")
      assert.equal(await run("document.querySelectorAll('[data-wallpaper-card]').length"), 6)
      await run("document.querySelector('[data-wallpaper-card=retro-grid]').click()")
      await wait(
        "document.querySelector('[data-wallpaper-card=retro-grid]').getAttribute('aria-pressed') === 'true'"
      )
      if (process.argv.includes('--screenshot')) {
        // Capture the trusted application window; a second window must not bypass IPC isolation.
        const screenshot = path.join(root, 'gallery.png')
        // Wake the hidden compositor first so it cannot return the previous Settings frame.
        await window.webContents.capturePage(undefined, { stayAwake: true })
        await delay(300)
        fs.writeFileSync(
          screenshot,
          (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG()
        )
        console.log('Gallery screenshot: ' + screenshot)
      }

      // Record an original silent clip locally so the test exercises a genuinely decodable video.
      const bytes = await run(`new Promise((resolve,reject)=>{
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
        const ctx=canvas.getContext('2d'),stream=canvas.captureStream(10),chunks=[];
        const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
        recorder.ondataavailable=e=>chunks.push(e.data);
        recorder.onerror=reject;
        recorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer())))};
        recorder.start();const draw=setInterval(()=>{ctx.fillStyle='#3266aa';ctx.fillRect(0,0,64,64)},30);
        setTimeout(()=>{clearInterval(draw);recorder.stop()},500)
      })`)
      chosen = path.join(root, 'Silent loop.webm')
      fs.writeFileSync(chosen, Buffer.from(bytes))
      await importWallpaper()
      await wait("document.querySelectorAll('[data-wallpaper-card]').length === 7")
      const videoId = (await run('window.electronAPI.getWallpapers()')).items.at(-1).id
      await run(`document.querySelector('[data-wallpaper-card="${videoId}"]').click()`)
      await wait("!!document.querySelector('.wallpaper-background video')")
      assert(
        await run(
          "(()=>{const v=document.querySelector('.wallpaper-background video');return v.muted && v.loop && v.volume===0})()"
        )
      )
      await pad(1)
      await pad(1)
      await run(
        "Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))"
      )
      await wait("document.querySelector('.wallpaper-background video')?.currentTime > 0")
      await run(
        `window.testPad={connected:true,index:0,id:'Cursor test',buttons:Array.from({length:17},()=>({pressed:false})),axes:[0,0,0,0]};Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.testPad]});window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse'}))`
      )
      await wait("document.documentElement.dataset.cursorHidden === 'false'")
      await run('window.testPad.axes[2]=0.6')
      await wait("document.documentElement.dataset.cursorHidden === 'true'")
      assert.equal(
        await run("getComputedStyle(document.querySelector('[data-settings-trigger]')).cursor"),
        'none'
      )
      await run(
        "window.testPad.axes[2]=0;window.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse'}))"
      )
      await wait("document.documentElement.dataset.cursorHidden === 'false'")
      await delay(2100)
      assert.equal(await run('document.documentElement.dataset.cursorHidden'), 'true')
      await run('window.testPad.connected=false')
      const saved = JSON.parse(fs.readFileSync(path.join(profile, 'zenith-preferences.json')))
      assert.equal(saved.wallpapers.selectedId, videoId)
      assert.equal(saved.wallpapers.onlyCustom, true)
      await new Promise((resolve) => {
        window.webContents.once('did-finish-load', resolve)
        window.reload()
      })
      await wait(
        `document.querySelector('[data-wallpaper-background]')?.dataset.wallpaperBackground === '${videoId}'`
      )
      assert(!(await run("!!document.querySelector('img.hero-fixed-image')")))
      await open()
      await run("document.querySelector('[data-wallpaper-only]').click()")
      await wait("!!document.querySelector('img.hero-fixed-image')")
      assert(await run("document.querySelector('.wallpaper-background video').paused"))
      await run(
        `document.querySelector('[data-wallpaper-card="${videoId}"]').focus({preventScroll:true})`
      )
      await pad(2)
      await wait("!!document.querySelector('[role=alertdialog]')")
      assert(await run("document.activeElement.hasAttribute('data-wallpaper-confirm')"))
      await pad(1)
      await wait("!document.querySelector('[role=alertdialog]')")
      assert.equal(await run('document.activeElement.dataset.wallpaperCard'), videoId)
      assert(fs.existsSync(path.join(profile, 'wallpapers', videoId)))
      await run(`document.querySelector('[data-delete-wallpaper="${videoId}"]').click()`)
      await wait("!!document.querySelector('[role=alertdialog]')")
      await pad(0)
      await wait("document.querySelectorAll('[data-wallpaper-card]').length === 6")
      assert(!fs.existsSync(path.join(profile, 'wallpapers', videoId)))
      assert.equal((await run('window.electronAPI.getWallpapers()')).selectedId, 'minimal-dark')
      // Multi-selection marks custom copies without activating them, with a separate confirmation.
      chosen = path.join(root, 'Multi.png')
      fs.writeFileSync(chosen, png)
      const extras = []
      for (let i = 0; i < 2; i++) {
        await importWallpaper()
        await wait(`document.querySelectorAll('[data-wallpaper-card]').length === ${7 + i}`)
        extras.push((await run('window.electronAPI.getWallpapers()')).items.at(-1).id)
      }
      await run(`document.querySelector('[data-wallpaper-card="${id}"]').click()`)
      await wait(
        `document.querySelector('[data-wallpaper-card="${id}"]').getAttribute('aria-pressed') === 'true'`
      )
      await run(`document.querySelector('[data-wallpaper-card="${extras[1]}"]').focus()`)
      const selectionScroll = await run("document.querySelector('[data-modal-content]').scrollTop")
      await pad(3)
      await wait(
        "document.querySelector('[data-wallpaper-gallery]').dataset.wallpaperSelecting === 'true'"
      )
      assert.equal(await run('document.activeElement.dataset.wallpaperCard'), extras[1])
      assert.equal(
        await run("document.querySelector('[data-modal-content]').scrollTop"),
        selectionScroll
      )
      assert.equal(
        await run(
          "document.querySelector('[data-wallpaper-selection-count]').textContent.startsWith('1')"
        ),
        true
      )
      assert.equal(
        await run("document.querySelectorAll('[data-wallpaper-card][role=checkbox]').length"),
        3
      )
      assert.equal(await run('document.activeElement.getAttribute("aria-checked")'), 'true')
      await pad(0)
      assert.equal(await run('document.activeElement.getAttribute("aria-checked")'), 'false')
      await pad(2)
      assert(
        !(await run("!!document.querySelector('[role=alertdialog]')")),
        'Empty selection cannot delete'
      )
      await pad(0)
      await pad(-1, 'left')
      assert.equal(await run('document.activeElement.dataset.wallpaperCard'), extras[0])
      await pad(0)
      assert.equal(
        await run("document.querySelectorAll('[data-wallpaper-card][aria-checked=true]').length"),
        2
      )
      assert.equal(
        await run("document.querySelector('[data-wallpaper-gallery]').dataset.wallpaperSelecting"),
        'true'
      )
      await pad(3)
      assert.equal(
        await run("document.querySelector('[data-wallpaper-gallery]').dataset.wallpaperSelecting"),
        'true',
        'Repeated Select toggles the card, never exits selection'
      )
      assert.equal(
        (await run('window.electronAPI.getWallpapers()')).selectedId,
        id,
        'Selection does not activate a wallpaper'
      )
      await pad(1)
      await wait(
        "document.querySelector('[data-wallpaper-gallery]').dataset.wallpaperSelecting === 'false'"
      )
      assert.equal(await run("document.querySelectorAll('[data-wallpaper-card]').length"), 8)
      await run(
        `document.querySelector('[data-wallpaper-card="${extras[1]}"]').focus(); document.querySelector('[data-wallpaper-card="${extras[1]}"]').dispatchEvent(new FocusEvent('focusin',{bubbles:true}));document.querySelector('[data-wallpaper-select-mode]').focus();document.querySelector('[data-wallpaper-select-mode]').click()`
      )
      await wait(
        "document.querySelector('[data-wallpaper-selection-count]').textContent.startsWith('1')"
      )
      assert.equal(await run('document.activeElement.dataset.wallpaperCard'), extras[1])
      await run(`document.querySelector('[data-wallpaper-card="${extras[0]}"]').click()`)
      await pad(2)
      await wait("!!document.querySelector('[role=alertdialog]')")
      await pad(1)
      await wait("!document.querySelector('[role=alertdialog]')")
      assert.equal(
        await run("document.querySelectorAll('[aria-checked=true][data-wallpaper-card]').length"),
        2
      )
      await pad(2)
      await pad(0)
      await wait("document.querySelectorAll('[data-wallpaper-card]').length === 6")
      assert(extras.every((extra) => !fs.existsSync(path.join(profile, 'wallpapers', extra))))
      assert(fs.existsSync(path.join(profile, 'wallpapers', id)))
      assert.equal((await run('window.electronAPI.getWallpapers()')).selectedId, id)
      assert.equal(
        await run("document.querySelector('[data-wallpaper-gallery]').dataset.wallpaperSelecting"),
        'false'
      )
      await run("document.querySelector('[data-delete-all-wallpapers]').click()")
      await wait("!!document.querySelector('[role=alertdialog]')")
      await run(
        "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))"
      )
      await wait("!document.querySelector('[role=alertdialog]')")
      assert(fs.existsSync(path.join(profile, 'wallpapers', id)))
      await run("document.querySelector('[data-delete-all-wallpapers]').click()")
      await wait("!!document.querySelector('[role=alertdialog]')")
      await pad(0)
      await wait("document.querySelectorAll('[data-wallpaper-card]').length === 5")
      assert.deepEqual(fs.readdirSync(path.join(profile, 'wallpapers')), [])
      await run("document.querySelector('[data-wallpaper-card=luminescent-glade]').click()")
      await wait("!!document.querySelector('.wallpaper-background .glade-scene')")
      assert.equal(
        await run("document.querySelectorAll('.wallpaper-background .glade-lights circle').length"),
        32
      )
      await run(
        "document.querySelector('dialog[open]').dispatchEvent(new Event('cancel',{cancelable:true}))"
      )
      await wait("!!document.querySelector('[data-console-modal=settings]')")
      console.log(
        'PASS: gallery stability, five themes, keyboard/gamepad navigation, imports, muted video, persistence, cursor activity/idle, single/bulk deletion, fallback and confirmation focus'
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
