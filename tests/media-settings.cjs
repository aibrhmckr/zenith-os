// Real Electron Main/preload/React; synthetic ISO, no external downloads or emulator processes.
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const assert = require('node:assert/strict')
const { ps3MediaIso } = require('./fixtures/ps3-media-iso.cjs')
const { paramSfo } = require('./fixtures/ps3-sfo.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-media-settings-'))
const profile = path.join(root, 'profile')
fs.mkdirSync(path.join(root, 'games'), { recursive: true })
fs.mkdirSync(profile)
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=',
  'base64'
)
fs.writeFileSync(
  path.join(root, 'games', 'Blur (PS3).iso'),
  ps3MediaIso(png, paramSfo({ TITLE_ID: 'BLUS30127', TITLE: 'Blur' }))
)
fs.writeFileSync(
  path.join(profile, 'zenith-preferences.json'),
  JSON.stringify({
    media: {
      downloadCovers: false,
      downloadBackgrounds: false,
      downloadVideos: false,
      downloadAudio: false
    }
  })
)
app.getAppPath = () => root
app.setPath('userData', profile)
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = () => {}
const requests = []
const fanart = nativeImage
  .createFromBitmap(Buffer.alloc(3840 * 2160 * 4), { width: 3840, height: 2160 })
  .toPNG()
const cover = nativeImage
  .createFromBitmap(Buffer.alloc(600 * 900 * 4), { width: 600, height: 900 })
  .toJPEG(90)
const clip = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(128)])
let releaseArtwork
const artworkGate = new Promise((resolve) => {
  releaseArtwork = resolve
})
globalThis.fetch = async (url) => {
  requests.push(url)
  if (url.includes('art.gametdb.com/ps3/cover/US/')) return new Response('', { status: 404 })
  if (url.includes('art.gametdb.com/ps3/cover/EN/')) return new Response(cover)
  if (url.includes('thumbnails.libretro.com'))
    return new Response(url.endsWith('/') ? '<a href="Blur%20(USA).png">Blur</a>' : png)
  const parsed = new URL(url)
  if (parsed.pathname === '/advancedsearch.php') {
    const q = parsed.searchParams.get('q')
    return Response.json({
      response: {
        docs: q.includes('title:fanart')
          ? [{ identifier: 'blur-fanart', title: 'Blur Fanart' }]
          : q.includes('video snaps')
            ? [{ identifier: 'ps3-snaps', title: 'Sony - PlayStation 3 Video Snaps HQ' }]
            : []
      }
    })
  }
  if (parsed.pathname === '/metadata/blur-fanart')
    return Response.json({
      files: [{ name: '4k.png', width: 3840, height: 2160, size: fanart.length }]
    })
  if (parsed.pathname === '/metadata/sony-playstation-3-video-snaps')
    return Response.json({
      files: [{ name: 'Blur (USA) - Preview.mp4', size: clip.length, length: 30 }]
    })
  if (parsed.pathname.startsWith('/download/blur-fanart/')) {
    await artworkGate
    return new Response(fanart)
  }
  if (parsed.pathname.startsWith('/download/sony-playstation-3-video-snaps/'))
    return new Response(clip)
  return Response.json({ response: { docs: [] } })
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(check) {
  for (let n = 0; n < 300; n++) {
    if (await check()) return
    await delay(20)
  }
  throw Error('Timeout: ' + check)
}
const timer = setTimeout(() => {
  console.error('UI test timeout')
  app.exit(1)
}, 45000)
app.once('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    const run = (code) => window.webContents.executeJavaScript(code)
    try {
      await wait(() =>
        run(
          "document.querySelector('[data-game-card] img') && !document.querySelector('[data-refresh-library]').disabled"
        )
      )
      let games = await run('window.electronAPI.getLocalGames()')
      assert(games[0].media.boxart.endsWith('embedded-icon0.png'))
      assert(games[0].media.snap.endsWith('embedded-pic1.png'))
      assert(!requests.some((url) => /thumbnails|mediatype%3Aimage|video|movies/.test(url)))
      await run("document.querySelector('[data-settings-trigger]').click()")
      await wait(() => run("document.querySelector('[data-media-setting=downloadCovers]')"))
      assert.equal(
        await run(
          "document.querySelector('[data-media-setting=downloadCovers]').getAttribute('aria-checked')"
        ),
        'false'
      )
      await run("document.querySelector('[data-media-setting=downloadCovers]').click()")
      await wait(() =>
        run(
          "document.querySelector('[data-media-setting=downloadCovers]').getAttribute('aria-checked') === 'true' && !document.querySelector('[data-media-setting=downloadCovers]').disabled"
        )
      )
      await wait(() =>
        run(
          "window.electronAPI.getLocalGames().then(g=>g[0].media.boxart.endsWith('cover-gametdb.jpg') && document.querySelector('[data-game-card] img')?.src===g[0].coverUrl && document.querySelector('[data-game-card] img')?.naturalWidth===600)"
        )
      )
      assert(requests.some((url) => url.includes('gametdb.com/ps3/cover/EN/BLUS30127.jpg')))
      // Late high-resolution completion must replace the visible backdrop, not just games.json.
      await run("document.querySelector('[data-media-setting=downloadBackgrounds]').click()")
      await wait(() =>
        run("!document.querySelector('[data-media-setting=downloadBackgrounds]').disabled")
      )
      releaseArtwork()
      await wait(() =>
        run(
          "window.electronAPI.getLocalGames().then(g=>document.querySelector('img.hero-fixed-image')?.src===g[0].backdropUrl && g[0].media.snap.endsWith('fanart.png'))"
        )
      )
      await run("document.querySelector('[data-media-setting=downloadVideos]').click()")
      await wait(() =>
        run(
          "document.querySelector('[data-media-setting=downloadVideos]').getAttribute('aria-checked') === 'true' && !document.querySelector('[data-media-setting=downloadVideos]').disabled"
        )
      )
      await wait(() =>
        run(
          "window.electronAPI.getLocalGames().then(g=>g[0].media.video && document.querySelector('video').src===g[0].videoUrl)"
        )
      )
      assert(requests.some((url) => url.includes('/download/sony-playstation-3-video-snaps/')))
      assert(
        !requests.some(
          (url) =>
            url.includes('advancedsearch') &&
            new URL(url).searchParams.get('q').includes('video snaps')
        )
      )
      await run("document.querySelector('[data-media-setting=downloadVideos]').click()")
      await wait(() =>
        run(
          "document.querySelector('[data-media-setting=downloadVideos]').getAttribute('aria-checked') === 'false' && !document.querySelector('[data-media-setting=downloadVideos]').disabled"
        )
      )
      await run("document.querySelector('[data-media-setting=downloadCovers]').click()")
      await wait(() =>
        run(
          "document.querySelector('[data-media-setting=downloadCovers]').getAttribute('aria-checked') === 'false' && !document.querySelector('[data-media-setting=downloadCovers]').disabled"
        )
      )
      await run("document.querySelector('[data-media-setting=downloadBackgrounds]').click()")
      await wait(() =>
        run("!document.querySelector('[data-media-setting=downloadBackgrounds]').disabled")
      )
      const saved = JSON.parse(fs.readFileSync(path.join(profile, 'zenith-preferences.json')))
      assert.deepEqual(saved.media, {
        downloadCovers: false,
        downloadBackgrounds: false,
        downloadVideos: false,
        downloadAudio: false
      })
      const invalid = await run('window.electronAPI.saveMediaPreferences({downloadVideos:"true"})')
      assert.equal(invalid.success, false)
      // A manual per-game rescrape must also enforce Main permissions.
      const before = requests.length
      await run(
        'window.electronAPI.getLocalGames().then(([g])=>window.electronAPI.rescrapeGame({id:g.id,gameId:g.gameId,platform:g.systemShort,title:g.title,path:g.path}))'
      )
      assert(
        !requests.slice(before).some((url) => /thumbnails|mediatype%3Aimage|video|movies/.test(url))
      )
      // Reload React; Main preferences survive, including after a hotkey save.
      await run('window.electronAPI.getHotkeys().then(window.electronAPI.saveHotkeys)')
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(profile, 'zenith-preferences.json'))).media,
        saved.media
      )
      const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
      window.webContents.reload()
      await loaded
      await wait(() => run("document.querySelector('[data-settings-trigger]')"))
      await run("document.querySelector('[data-settings-trigger]').click()")
      await wait(() =>
        run(
          "document.querySelector('[data-media-setting=downloadCovers]')?.getAttribute('aria-checked') === 'false'"
        )
      )
      console.log(
        'PASS: Settings switches, persisted startup permissions, offline PS3 ISO artwork, online priority, targeted rescan and hotkey coexistence'
      )
      clearTimeout(timer)
      app.exit(0)
    } catch (error) {
      console.error(error)
      console.error(
        await run(
          "window.electronAPI.getLocalGames().then(g=>({media:g[0]?.media, backdrop:g[0]?.backdropUrl, actual:document.querySelector('img.hero-fixed-image')?.src}))"
        )
      )
      console.error(requests)
      clearTimeout(timer)
      app.exit(1)
    }
  })
})
require('../out/main/index.js')
