// Real renderer/IPC and filesystem; synthetic DLL/ROM/WAV and native/process doubles.
const { app, BrowserWindow, dialog } = require('electron')
const { EventEmitter } = require('node:events')
const childProcess = require('node:child_process')
const assert = require('node:assert/strict')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const { coreArchive } = require('./fixtures/core-archive.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-console-ui-'))
const profile = path.join(root, 'profile'),
  retroarch = path.join(root, 'emulators', 'retroarch')
fs.mkdirSync(path.join(root, 'games'), { recursive: true })
fs.mkdirSync(retroarch, { recursive: true })
fs.writeFileSync(path.join(retroarch, 'retroarch.exe'), '')
const rom = path.join(root, 'Imported Game.gba')
fs.writeFileSync(rom, 'synthetic game')
app.getAppPath = () => root
app.setPath('userData', profile)
app.disableHardwareAcceleration()
const actions = []
for (const action of ['show', 'hide', 'restore', 'focus', 'setAlwaysOnTop'])
  BrowserWindow.prototype[action] = (...args) => actions.push([action, ...args])
let selection = { canceled: true, filePaths: [] }
dialog.showOpenDialog = async (_window, options) => {
  if (options.filters?.[0]?.name === 'Tüm Desteklenen Oyunlar') {
    for (const ext of [
      'a26',
      'a78',
      'bin',
      'rom',
      'lnx',
      'atx',
      'zip',
      '7z',
      'smd',
      'gen',
      'cue',
      'v64'
    ])
      assert(options.filters[0].extensions.includes(ext), 'Missing picker extension: ' + ext)
    assert.deepEqual(options.filters[1], { name: 'Tüm Dosyalar (*.*)', extensions: ['*'] })
  }
  return selection
}
dialog.showMessageBox = async () => ({ response: 0 })
const requests = [],
  spawns = []
globalThis.fetch = async (url) => {
  requests.push(url)
  return url.endsWith('/mgba_libretro.dll.zip')
    ? new Response(coreArchive('mgba_libretro.dll'))
    : new Response('', { status: 404 })
}
childProcess.spawn = (command, args, options) => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {
    child.killed = true
    child.emit('exit', null, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
    return true
  }
  spawns.push({ child, command, args, options, time: Date.now() })
  setTimeout(() => child.emit('spawn'), 20)
  return child
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function run(window) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const wait = async (code) => {
    for (let i = 0; i < 250; i++) {
      if (await evaluate(code)) return
      await delay(20)
    }
    throw Error('Timed out: ' + code)
  }
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); undefined`)
  const key = (key) =>
    evaluate(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true})); undefined`
    )
  const pad = async (button, move = null) => {
    await evaluate(
      `document.querySelector('dialog[open]').dispatchEvent(new CustomEvent('controller-input', {detail:{hit:index=>index===${button},move:${JSON.stringify(move)},axes:[0,0,0,0],now:performance.now()}}));undefined`
    )
    await delay(50)
  }
  await evaluate(`window.sfxEvents=[]; window.sfxVoices=[]; window.Audio=class {
    constructor(src){this.src=src;this.id=window.sfxVoices.push(this)} currentTime=0; volume=0; paused=true;
    play(){this.paused=false;window.sfxEvents.push(this.id);return Promise.resolve()} pause(){this.paused=true} removeAttribute(){} load(){}
  };undefined`)
  await delay(120)
  await wait("!document.querySelector('[data-add-game]').disabled")
  assert(await evaluate("document.documentElement.lang==='en'"))
  selection = { canceled: false, filePaths: [rom] }
  await click('[data-add-game]')
  await wait(
    "document.querySelectorAll('[data-game-card]').length===1 && !document.querySelector('[data-refresh-library]').disabled"
  )
  const game = (await evaluate('window.electronAPI.getLocalGames()'))[0]
  assert.equal(game.path, path.join(root, 'games', path.basename(rom)))
  assert.equal(fs.readFileSync(game.path, 'utf8'), 'synthetic game')
  fs.unlinkSync(rom)
  assert(fs.existsSync(game.path), 'Deleting Desktop original preserves imported game')
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('[data-game-card]')).aspectRatio"),
    '2 / 3'
  )
  assert(
    await evaluate("document.querySelector('[data-game-card]').classList.contains('scale-105')")
  )
  assert.equal((await evaluate("window.electronAPI.deleteGame('../outside')")).success, false)
  const filterRoms = ['A.iso', 'B.nes', 'C.sfc', 'D.nds'].map((name) =>
    path.join(root, 'games', name)
  )
  filterRoms.forEach((file) => fs.writeFileSync(file, 'synthetic fixture'))
  await click('[data-refresh-library]')
  await wait(
    "document.querySelectorAll('[data-game-card]').length===5 && !document.querySelector('[data-refresh-library]').disabled"
  )
  await key('f')
  await wait("!!document.querySelector('[data-console-modal=filter][open]')")
  assert.deepEqual(
    await evaluate(
      "Array.from(document.querySelectorAll('#console-filters button')).map(el=>el.textContent)"
    ),
    ['All consoles', 'PS2', 'NDS', 'GBA', 'SNES', 'NES']
  )
  assert.equal(await evaluate('document.activeElement.textContent'), 'All consoles')
  await evaluate('document.activeElement.blur();undefined')
  await pad(-1)
  assert.equal(
    await evaluate('document.activeElement.textContent'),
    'All consoles',
    'Filter repairs lost DOM focus'
  )
  await pad(-1, 'right')
  assert.equal(await evaluate('document.activeElement.textContent'), 'PS2')
  await pad(-1, 'down')
  assert.equal(await evaluate('document.activeElement.textContent'), 'SNES')
  await pad(-1, 'left')
  assert.equal(await evaluate('document.activeElement.textContent'), 'GBA')
  await pad(-1, 'up')
  assert.equal(await evaluate('document.activeElement.textContent'), 'All consoles')
  await pad(1)
  await wait("!document.querySelector('dialog[open]')")
  filterRoms.forEach((file) => fs.unlinkSync(file))
  await click('[data-refresh-library]')
  await wait(
    "document.querySelectorAll('[data-game-card]').length===1 && !document.querySelector('[data-refresh-library]').disabled"
  )
  if (process.argv.includes('--screenshot')) {
    const files = [
      'Aurora.iso',
      'Circuit.nes',
      'Starflight.z64',
      'Drift.gba',
      'Night.gba',
      'Ocean.gba',
      'Prism.gba',
      'Orbit.gba',
      'Summit.gba',
      'Valley.gba',
      'Wave.gba'
    ].map((name) => path.join(root, 'games', name))
    files.forEach((file) => fs.writeFileSync(file, ''))
    const preview = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        offscreen: true,
        preload: path.resolve(__dirname, '../out/preload/index.js'),
        sandbox: false
      }
    })
    await preview.loadFile(path.resolve(__dirname, '../out/renderer/index.html'))
    for (let i = 0; i < 100; i++) {
      if (
        await preview.webContents.executeJavaScript(
          "document.querySelectorAll('[data-game-card]').length===12"
        )
      )
        break
      await delay(30)
    }
    await preview.webContents.executeJavaScript(
      `window.previewPad={connected:true,index:0,id:'Xbox fixture',axes:[0.26,0,0,0],buttons:Array.from({length:17},()=>({pressed:false}))};Object.defineProperty(navigator,'getGamepads',{value:()=>[window.previewPad]});undefined`
    )
    await delay(600)
    const screenshot = path.join(root, 'console-ui.png')
    fs.writeFileSync(screenshot, (await preview.webContents.capturePage()).toPNG())
    console.log('SCREENSHOT: ' + screenshot)
    const previewWait = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await preview.webContents.executeJavaScript(code)) return
        await delay(30)
      }
      throw Error('Preview timeout: ' + code)
    }
    preview.setSize(1920, 1080)
    await previewWait("Number(document.querySelector('.dashboard-library').dataset.columns)===11")
    await preview.webContents.executeJavaScript(
      "document.querySelector('.zenith-shell').style.background='#e2e5db';undefined"
    )
    const layout = await preview.webContents.executeJavaScript(`(() => {
      const grid=document.querySelector('.poster-grid'), cards=[...grid.children], rect=grid.getBoundingClientRect();
      return { widths:cards.map(c=>c.offsetWidth), height:cards[0].offsetHeight, gap:getComputedStyle(grid).columnGap, justify:getComputedStyle(grid).justifyContent, step:cards[1].offsetLeft-cards[0].offsetLeft, rowStep:cards[11].offsetTop-cards[0].offsetTop, visibleRows:rect.height, left:rect.left }
    })()`)
    assert(layout.widths.every((width) => width === 144))
    assert.equal(layout.height, 216)
    assert.equal(layout.gap, '16px')
    assert.equal(layout.justify, 'start')
    assert.equal(layout.step, 160)
    assert.equal(layout.rowStep, 232)
    assert(layout.visibleRows <= 260, 'First row uses a single-row showcase')
    assert.equal(layout.left, 48)
    await preview.webContents.executeJavaScript(
      "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));undefined"
    )
    await previewWait("document.querySelector('.dashboard-library').dataset.expanded==='true'")
    await delay(400)
    const expanded = await preview.webContents.executeJavaScript(
      "JSON.stringify({height:document.querySelector('.poster-grid').getBoundingClientRect().height, library:document.querySelector('.dashboard-library').outerHTML.slice(0,170),columns:getComputedStyle(document.querySelector('.poster-grid')).gridTemplateColumns,selected:document.querySelector('[aria-pressed=true]')?.getAttribute('aria-label')})"
    )
    assert(JSON.parse(expanded).height >= 464, expanded)
    fs.writeFileSync(
      path.join(root, 'dashboard-1920-contrast.png'),
      (await preview.webContents.capturePage()).toPNG()
    )
    await preview.webContents.executeJavaScript(
      "document.querySelector('.zenith-shell').style.background='';undefined"
    )
    preview.setSize(1024, 768)
    await previewWait("Number(document.querySelector('.dashboard-library').dataset.columns)===5")
    await preview.webContents.executeJavaScript(
      "document.querySelector('[data-game-card]').click();undefined"
    )
    await previewWait(
      "document.querySelectorAll('[data-game-card]')[0].getAttribute('aria-pressed')==='true'"
    )
    await delay(80)
    await preview.webContents.executeJavaScript(
      "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));undefined"
    )
    await previewWait(
      "document.querySelectorAll('[data-game-card]')[5].getAttribute('aria-pressed')==='true'"
    )
    preview.setSize(1280, 800)
    await previewWait("Number(document.querySelector('.dashboard-library').dataset.columns)===7")
    await preview.webContents.executeJavaScript(
      'window.previewPad.buttons[16].pressed=false;window.previewPad.buttons[2].pressed=true;undefined'
    )
    await previewWait("!!document.querySelector('[data-osk][open]')")
    await delay(350)
    fs.writeFileSync(path.join(root, 'osk.png'), (await preview.webContents.capturePage()).toPNG())
    await preview.webContents.executeJavaScript(
      'window.previewPad.buttons[2].pressed=false;window.previewPad.buttons[1].pressed=true;undefined'
    )
    await previewWait("!document.querySelector('[data-osk]')")
    await preview.webContents.executeJavaScript(
      'window.previewPad.buttons[1].pressed=false;window.previewPad.buttons[9].pressed=true;undefined'
    )
    await delay(70)
    await preview.webContents.executeJavaScript(
      'window.previewPad.buttons[9].pressed=false;undefined'
    )
    await previewWait("!!document.querySelector('[data-console-modal=settings][open]')")
    await delay(350)
    fs.writeFileSync(
      path.join(root, 'settings.png'),
      (await preview.webContents.capturePage()).toPNG()
    )
    preview.destroy()
    files.forEach((file) => fs.unlinkSync(file))
  }
  assert.equal(await evaluate('typeof window.electronAPI.uploadSoundEffect'), 'undefined')
  assert.equal(await evaluate("document.querySelector('[data-toggle-sound]')"), null)
  assert.equal(await evaluate("document.querySelectorAll('main [data-launch-game]').length"), 0)
  await key('ContextMenu')
  await wait("!!document.querySelector('[data-console-modal=settings][open]')")
  assert.equal(await evaluate("document.activeElement.getAttribute('role')"), 'combobox')
  assert.equal(await evaluate('document.activeElement.dataset.controllerFocused'), 'true')
  assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineWidth'), '2px')
  await evaluate('document.activeElement.blur();undefined')
  await pad(-1)
  assert.equal(
    await evaluate("document.activeElement.getAttribute('role')"),
    'combobox',
    'Settings repairs lost DOM focus'
  )
  await pad(0)
  await wait("!!document.querySelector('[role=listbox]')")
  await pad(1)
  await wait(
    "!document.querySelector('[role=listbox]') && !!document.querySelector('dialog[open]')"
  )
  await pad(0)
  await pad(-1, 'down')
  await pad(0)
  await wait("document.documentElement.lang==='tr'")
  await pad(0)
  await pad(-1, 'up')
  await pad(0)
  await wait("document.documentElement.lang==='en'")
  assert((await evaluate('window.sfxEvents.length')) > 0, 'Dropdown and focus use WAV sounds')
  await click('[data-system-page]')
  await wait("!!document.querySelector('[data-console-modal=systems][open]')")
  assert.equal((await evaluate('window.electronAPI.getSystemStatus()')).length, 1)
  assert.equal(await evaluate("document.querySelectorAll('[data-delete-bios]').length"), 0)
  await pad(1)
  await wait("!!document.querySelector('[data-console-modal=settings][open]')")
  await evaluate('window.sfxVoices.forEach(voice=>voice.pause());window.sfxEvents=[];undefined')
  for (let i = 0; i < 4; i++) {
    await evaluate(
      "window.dispatchEvent(new CustomEvent('zenith-sound',{detail:'navigate'}));undefined"
    )
    await delay(45)
  }
  assert.equal(
    await evaluate('new Set(window.sfxEvents).size'),
    4,
    'Rapid navigation uses four overlapping voices'
  )
  assert.equal(await evaluate('window.sfxVoices.filter(voice=>!voice.paused).length'), 4)
  await click('[data-audio-setting=menuSounds]')
  await wait(
    "document.querySelector('[data-audio-setting=menuSounds]').getAttribute('aria-checked')==='false'"
  )
  assert(
    await evaluate('window.sfxVoices.every(voice=>voice.paused)'),
    'Mute stops all active menu voices'
  )
  const tones = await evaluate('window.sfxEvents.length')
  await click('[data-audio-setting=previewSound]')
  await wait(
    "document.querySelector('[data-audio-setting=previewSound]').getAttribute('aria-checked')==='true'"
  )
  assert.equal(
    await evaluate('window.sfxEvents.length'),
    tones,
    'Muted menu sounds create no tones'
  )
  await pad(1)
  await wait("!document.querySelector('dialog')")
  const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
  window.webContents.reload()
  await reloaded
  await wait("document.querySelectorAll('[data-game-card]').length===1")
  await key('ContextMenu')
  await wait("!!document.querySelector('[data-audio-setting=menuSounds]')")
  assert.equal(
    await evaluate(
      "document.querySelector('[data-audio-setting=menuSounds]').getAttribute('aria-checked')"
    ),
    'false'
  )
  assert.equal(
    await evaluate(
      "document.querySelector('[data-audio-setting=previewSound]').getAttribute('aria-checked')"
    ),
    'true'
  )
  await pad(1)
  await wait("!document.querySelector('dialog')")
  // The launch must finish its 500 ms media fade before opening the missing-core panel.
  const before = Date.now()
  await click('[data-launch-game]')
  await wait("!!document.querySelector('[data-console-modal=core][open]')")
  assert(Date.now() - before >= 450)
  assert.equal(spawns.length, 0)
  await pad(-1, 'down')
  assert.equal(await evaluate('document.activeElement.textContent.trim()'), 'Cancel')
  await pad(-1, 'down')
  assert.equal(await evaluate('document.activeElement.textContent.trim()'), 'Browse cores')
  await pad(-1, 'up')
  await pad(-1, 'up')
  assert.equal(await evaluate('document.activeElement.textContent.trim()'), 'Download')
  await pad(0)
  await wait(
    "document.querySelector('[data-launch-game]').disabled && !document.querySelector('dialog')"
  )
  for (let i = 0; i < 250 && !spawns.length; i++) await delay(20)
  assert.equal(spawns.length, 1)
  await delay(80)
  assert.equal(spawns[0].options.detached, true)
  assert.equal(spawns[0].options.cwd, retroarch)
  assert(actions.some(([a]) => a === 'hide'))
  const cfg = fs.readFileSync(spawns[0].args.at(-1), 'utf8')
  assert(cfg.includes('pause_nonactive = true'))
  assert(cfg.includes('input_menu_toggle_btn = "nul"'))
  assert(cfg.includes(profile.replaceAll('\\', '/')))
  await evaluate('window.electronAPI.showSessionMenu()')
  await wait("!!document.querySelector('[data-console-modal=session][open]')")
  await pad(1)
  await wait("!document.querySelector('dialog')")
  await evaluate('window.electronAPI.showSessionMenu()')
  await wait("!!document.querySelector('[data-console-modal=session][open]')")
  await pad(-1, 'down')
  await pad(0)
  await wait(
    "!document.querySelector('dialog') && !document.querySelector('[data-launch-game]').disabled"
  )
  assert.deepEqual(
    actions.slice(-4).map(([a]) => a),
    ['setAlwaysOnTop', 'show', 'restore', 'focus']
  )
  // Populate all per-game caches, then delete via the confirmation modal.
  const cache = path.join(profile, 'media', game.gameId)
  for (const name of [
    'theme.mp3',
    'preview.mp4',
    'boxart.png',
    'manual/page-0.jpg',
    'saves/game.srm',
    'states/game.state'
  ]) {
    const file = path.join(cache, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'synthetic cache')
  }
  await key('Delete')
  await wait("!!document.querySelector('[data-console-modal=delete][open]')")
  assert(
    await evaluate(
      "document.querySelector('dialog').textContent.includes('including the source ROM file')"
    )
  )
  assert.equal(await evaluate("document.activeElement.hasAttribute('data-confirm-delete')"), true)
  await pad(-1, 'down')
  await pad(-1, 'down')
  assert(await evaluate("document.activeElement.hasAttribute('data-confirm-delete')"))
  await pad(0)
  await wait(
    "!document.querySelector('dialog') && document.querySelectorAll('[data-game-card]').length===0"
  )
  assert(!fs.existsSync(cache))
  assert.equal(fs.existsSync(game.path), false)
  const records = JSON.parse(fs.readFileSync(path.join(profile, 'games.json'), 'utf8')).games
  assert.equal(records[game.gameId], undefined)
  assert.equal((await evaluate('window.electronAPI.getLocalGames()')).length, 0)
  assert(requests.some((url) => url.includes('buildbot.libretro.com')))
  console.log(
    'PASS: English/TR gamepad dropdown, custom WAV mute and persisted audio preferences, add game, poster layout, 500ms launch fade, core install/retry, detached session hide/resume/stop, confirmed cache/save deletion and physical ROM deletion'
  )
}
const timeout = setTimeout(() => {
  console.error('Console test timeout')
  app.exit(1)
}, 45000)
app.once('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false)
  window.webContents.once('did-finish-load', async () => {
    try {
      await run(window)
      clearTimeout(timeout)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.log(await window.webContents.executeJavaScript('document.body.innerText'))
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
