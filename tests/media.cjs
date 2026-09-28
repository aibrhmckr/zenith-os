// Real Electron/cache/protocol/UI; fake CDN and playback spies keep this test silent/offline.
const { app, BrowserWindow, nativeImage, net } = require('electron')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-media-test-'))
const profile = path.join(root, 'profile')
const roms = path.join(root, 'games')
fs.mkdirSync(roms)
fs.mkdirSync(path.join(root, 'media', 'music'), { recursive: true })
fs.mkdirSync(path.join(root, 'media', 'videos'), { recursive: true })
const mediaId = (system, title, name) =>
  `${system.toLowerCase()}-${title.toLowerCase()}-${createHash('sha256').update(`${system}:${name}`).digest('hex').slice(0, 12)}`
const alphaId = mediaId('PS2', 'Alpha', 'Alpha (USA).iso')
const betaId = mediaId('NDS', 'Beta', 'Beta (USA).nds')
fs.writeFileSync(path.join(roms, 'Alpha (USA).iso'), '')
fs.writeFileSync(path.join(roms, 'Beta (USA).nds'), '')
fs.mkdirSync(path.join(profile, 'media', alphaId), { recursive: true })
fs.writeFileSync(path.join(profile, 'media', alphaId, 'theme.mp3'), '0123456789')
fs.writeFileSync(path.join(profile, 'media', alphaId, 'preview.mp4'), '0123456789')
app.getAppPath = () => root
app.setPath('userData', profile)
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = () => {}
const png = nativeImage
  .createFromBitmap(Buffer.from([180, 80, 40, 255]), { width: 1, height: 1 })
  .toPNG()
const downloads = []
const bgmBytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(128)])
const videoBytes = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypisom'),
  Buffer.alloc(128)
])
let releaseBgm
let releaseVideo
const bgmGate = new Promise((resolve) => {
  releaseBgm = resolve
})
const videoGate = new Promise((resolve) => {
  releaseVideo = resolve
})
globalThis.fetch = async (url) => {
  const parsed = new URL(url)
  if (parsed.pathname === '/advancedsearch.php') {
    const video = parsed.searchParams.get('q').includes('video snaps')
    return Response.json({
      response: {
        docs: [
          video
            ? { identifier: 'ds-snaps', title: 'Nintendo DS Video Snaps' }
            : { identifier: 'beta-ost', title: 'Beta Soundtrack' }
        ]
      }
    })
  }
  if (parsed.pathname === '/metadata/beta-ost')
    return Response.json({ files: [{ name: 'Title.mp3', size: bgmBytes.length, length: '30' }] })
  if (parsed.pathname === '/metadata/ds-snaps')
    return Response.json({
      files: [{ name: 'Beta (USA).mp4', size: videoBytes.length, length: '30' }]
    })
  if (parsed.pathname.startsWith('/download/beta-ost/')) {
    await bgmGate
    return new Response(bgmBytes)
  }
  if (parsed.pathname.startsWith('/download/ds-snaps/')) {
    await videoGate
    return new Response(videoBytes)
  }
  downloads.push(url)
  if (url.endsWith('/'))
    return new Response('<a href="Alpha%20(USA).png">Alpha</a><a href="Beta%20(USA).png">Beta</a>')
  return new Response(png)
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check) {
  for (let i = 0; i < 220; i++) {
    if (await check()) return
    await delay(20)
  }
  throw Error(`Timed out: ${check.toString()}`)
}
async function checkMedia(window) {
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  await evaluate(`window.mediaEvents = [];
    HTMLMediaElement.prototype.play = function() { if (!this.src.startsWith('game-media:')) return Promise.resolve(); window.mediaEvents.push({type:'play', src:this.src, volume:this.volume, tag:this.tagName, time:performance.now()}); return Promise.resolve() };
    HTMLMediaElement.prototype.pause = function() { if (!this.src.startsWith('game-media:')) return; window.mediaEvents.push({type:'pause', src:this.src, tag:this.tagName}) }; undefined`)
  await waitFor(() =>
    evaluate(
      "document.querySelectorAll('[data-game-card]').length === 2 && !document.querySelector('[data-refresh-library]').disabled"
    )
  )
  assert.equal(downloads.filter((url) => !url.endsWith('/')).length, 6)
  const games = await evaluate('window.electronAPI.getLocalGames()')
  assert.equal(games[0].title, 'Alpha')
  assert.equal(games[0].gameId, alphaId)
  assert.equal(games[0].region, 'USA')
  assert.equal(games[1].gameId, betaId)
  assert(games[0].cover.startsWith(path.join(profile, 'media', alphaId)))
  assert(games[0].backdrop.endsWith('snap.png'))
  assert(games[0].musicUrl && games[0].videoUrl)
  assert.equal(games[1].musicUrl, null)
  assert.equal(games[1].videoUrl, null)
  await waitFor(() =>
    evaluate(
      "Array.from(document.querySelectorAll('[data-game-card] img')).every(img => img.complete && img.naturalWidth > 0)"
    )
  )
  const bytes = await net.fetch(games[0].videoUrl, { headers: { Range: 'bytes=3-5' } })
  assert.equal(bytes.status, 206)
  assert.equal(await bytes.text(), '345')
  assert(fs.existsSync(path.join(profile, 'games.json')))

  // Enable preview audio through Settings (the default dashboard video is silent).
  await evaluate(
    "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}));undefined"
  )
  await waitFor(() => evaluate("!!document.querySelector('[data-audio-setting=previewSound]')"))
  await evaluate(
    "document.querySelector('[data-audio-setting=previewSound]').click();document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}));undefined"
  )
  // Focus/hovers debounce; leaving before 800ms never starts either media track.
  await evaluate(
    "document.querySelector('input').focus(); document.querySelector('input').dispatchEvent(new FocusEvent('focusin',{bubbles:true})); window.mediaEvents = []; window.hoverStartedAt=performance.now()"
  )
  await evaluate(
    "document.querySelector('[aria-label=Alpha][data-game-card]').dispatchEvent(new MouseEvent('mouseover', {bubbles:true}))"
  )
  await delay(350)
  assert.equal(
    await evaluate("window.mediaEvents.filter(e => e.type==='play').length"),
    0,
    JSON.stringify(
      await evaluate(
        '({events:window.mediaEvents,started:window.hoverStartedAt,now:performance.now(),active:document.activeElement.tagName})'
      )
    )
  )
  await evaluate(
    "document.querySelector('[aria-label=Alpha][data-game-card]').dispatchEvent(new MouseEvent('mouseout', {bubbles:true}))"
  )
  await delay(550)
  assert.equal(await evaluate("window.mediaEvents.filter(e => e.type==='play').length"), 0)
  assert.equal(
    await evaluate("document.querySelector('[data-cinematic]').dataset.cinematic"),
    'false'
  )

  await evaluate(
    "document.querySelector('[aria-label=Alpha][data-game-card]').focus(); document.querySelector('[aria-label=Alpha][data-game-card]').dispatchEvent(new FocusEvent('focusin',{bubbles:true})); window.startedAt = performance.now()"
  )
  await waitFor(() => evaluate("window.mediaEvents.filter(e => e.type==='play').length === 2"))
  assert(
    await evaluate(
      "window.mediaEvents.filter(e => e.type==='play').every(e => e.time - window.startedAt >= 750)"
    )
  )
  assert.equal(
    await evaluate("document.querySelector('[data-cinematic]').dataset.cinematic"),
    'true'
  )
  assert.equal(
    await evaluate("document.querySelector('video').muted"),
    true,
    'Music wins over video audio'
  )
  assert.equal(await evaluate("window.mediaEvents.find(e => e.type==='play').volume"), 0)
  await delay(500)
  const volume = await evaluate("document.querySelector('audio').volume")
  assert(volume > 0 && volume <= 0.3)

  // Gamepad selects a new game: old media is paused/reset, new preview gets its own delay.
  await evaluate(
    "window.oldAudio=document.querySelector('audio'); window.oldVideo=document.querySelector('video'); window.mediaEvents=[]; window.pad={connected:true,axes:[0,0],buttons:Array.from({length:16},()=>({pressed:false}))}; Object.defineProperty(navigator,'getGamepads',{value:()=>[window.pad]}); window.pad.buttons[15].pressed=true"
  )
  await waitFor(() => evaluate("document.querySelector('h1').textContent === 'Beta'"))
  await evaluate('window.pad.buttons[15].pressed=false')
  await delay(180)
  assert.equal(await evaluate('window.oldAudio.volume'), 0)
  assert.equal(await evaluate('window.oldAudio.currentTime'), 0)
  assert(await evaluate("window.mediaEvents.some(e=>e.type==='pause' && e.tag==='AUDIO')"))
  assert.equal(await evaluate("window.mediaEvents.filter(e=>e.type==='play').length"), 0)
  // Video arrives first while music remains pending, without a library refresh.
  await evaluate(
    'window.bgmUpdates=[]; window.removeBgmListener=window.electronAPI.onGameMediaUpdated(game=>window.bgmUpdates.push(game)); window.mediaEvents=[]; undefined'
  )
  releaseVideo()
  await waitFor(() => evaluate('window.bgmUpdates.some(game=>game.media.video)'))
  const videoUpdate = await evaluate('window.bgmUpdates[0]')
  assert.equal(videoUpdate.media.video, path.join(profile, 'media', betaId, 'preview.mp4'))
  assert.equal(videoUpdate.media.music, null)
  const downloadedVideo = await net.fetch(videoUpdate.videoUrl)
  assert.deepEqual(Buffer.from(await downloadedVideo.arrayBuffer()), videoBytes)
  await waitFor(() => evaluate("window.mediaEvents.some(e=>e.type==='play' && e.tag==='VIDEO')"))
  assert.equal(await evaluate("document.querySelector('video').muted"), false)

  // A late BGM download reaches the mounted React library without a refresh.
  await evaluate('window.mediaEvents=[]')
  releaseBgm()
  await waitFor(() => evaluate('window.bgmUpdates.some(game=>game.media.music)'))
  const update = await evaluate('window.bgmUpdates.at(-1)')
  assert.equal(update.gameId, betaId)
  assert.equal(update.media.music, path.join(profile, 'media', betaId, 'theme.mp3'))
  assert.equal(update.media.video, videoUpdate.media.video)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(profile, 'games.json'))).games[betaId].media.music,
    update.media.music
  )
  const bgm = await net.fetch(update.musicUrl)
  assert.deepEqual(Buffer.from(await bgm.arrayBuffer()), bgmBytes)
  await waitFor(() => evaluate("window.mediaEvents.some(e=>e.type==='play' && e.tag==='AUDIO')"))
  assert.equal(await evaluate("document.querySelector('video').muted"), true)
  await evaluate('window.removeBgmListener(); undefined')

  await evaluate("window.dispatchEvent(new Event('blur'))")
  assert.equal(await evaluate("document.querySelector('video').volume"), 0)
  await waitFor(() =>
    evaluate("document.querySelector('[data-cinematic]').dataset.cinematic === 'false'")
  )
  await evaluate("window.dispatchEvent(new Event('focus'))")
  await waitFor(() =>
    evaluate("document.querySelector('[data-cinematic]').dataset.cinematic === 'true'")
  )
  const priorRequests = downloads.length
  await evaluate("document.querySelector('[data-refresh-library]').click()")
  await waitFor(() => evaluate("!document.querySelector('[data-refresh-library]').disabled"))
  assert.equal(downloads.length, priorRequests, 'Refresh reuses complete cached artwork')

  // A rejected playback promise is contained, while selection and static artwork remain usable.
  await evaluate(
    "document.querySelector('input').focus(); document.querySelector('input').dispatchEvent(new FocusEvent('focusin',{bubbles:true})); HTMLMediaElement.prototype.play = () => Promise.reject(new Error('unsupported test codec')); window.addEventListener('unhandledrejection',()=>window.playbackRejected=true); document.querySelector('[aria-label=Alpha][data-game-card]').focus(); document.querySelector('[aria-label=Alpha][data-game-card]').dispatchEvent(new FocusEvent('focusin',{bubbles:true}))"
  )
  await delay(1800)
  assert.equal(await evaluate('Boolean(window.playbackRejected)'), false)
  assert.equal(await evaluate("document.querySelector('h1').textContent"), 'Alpha')
  console.log(
    'PASS: Archive.org MP3/MP4 downloads, userData cache, independent video/music IPC and live preview, CDN covers, ranges, 800ms debounce, 30% fade, hover/focus/gamepad cleanup, blur, refresh and codec failure'
  )
}
const timeout = setTimeout(() => {
  console.error('Media test timed out')
  app.exit(1)
}, 45000)
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      await checkMedia(window)
      clearTimeout(timeout)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.log(
        await window.webContents.executeJavaScript(
          "JSON.stringify({events:window.mediaEvents, hidden:document.hidden, focused:document.activeElement.outerHTML.slice(0,100), cinematic:document.querySelector('[data-cinematic]').dataset.cinematic})"
        )
      )
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
