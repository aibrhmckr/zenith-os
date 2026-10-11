import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createPreferences,
  mediaPreferences,
  MEDIA_DEFAULTS
} from '../src/main/services/preferences.js'
import { createScraper } from '../src/main/services/scraper.js'
import { createPs3IsoExtractor } from '../src/main/services/ps3IsoMedia.js'
import { createMediaDownloader } from '../src/main/services/mediaScraper.js'
import { mediaUrl } from '../src/main/services/local-media.js'
import { ps3MediaIso } from './fixtures/ps3-media-iso.cjs'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=',
  'base64'
)
function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-media-permissions-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  return userData
}

test('each of the four permissions independently gates PS3 and RetroArch media requests', async (t) => {
  for (const systemShort of ['PS3', 'PS2']) {
    for (const enabled of [null, ...Object.keys(MEDIA_DEFAULTS)]) {
      const userData = fixture(t),
        calls = [],
        logs = []
      const preferences = Object.fromEntries(
        Object.keys(MEDIA_DEFAULTS).map((key) => [key, key === enabled])
      )
      const scraper = createScraper({
        userData,
        getPreferences: () => preferences,
        logger: { log: (message) => logs.push(message) },
        fetchImpl: async (url) => {
          calls.push(decodeURIComponent(url))
          return new Response('', { status: 404 })
        }
      })
      const game = { fileName: 'Blur.iso', systemShort }
      await scraper.rescrape([game], scraper.enrich(game).gameId)
      const covers = calls.some((url) => /Named_Boxarts|title:boxart|title:logo/.test(url))
      const backgrounds = calls.some((url) => /Named_Snaps|Named_Titles|title:fanart/.test(url))
      const videos = calls.some((url) => /video\+snaps|mediatype:movies/.test(url))
      const audio = calls.some((url) => /vgm_ost|mediatype:audio/.test(url))
      assert.deepEqual(
        [covers, backgrounds, videos, audio],
        Object.keys(MEDIA_DEFAULTS).map((key) => key === enabled)
      )
      assert(logs.some((line) => line.includes('İstek alındı: Blur (' + systemShort + ')')))
      assert(logs.some((line) => line.includes('Ayarlar: Kapak:')))
      if (enabled) assert(logs.some((line) => line.includes('Sorgulanan URL:')))
      else assert.equal(calls.length, 0, 'All off means no media network traffic')
    }
  }
})

test('manual rescrape waits for pending audio then retries it instead of losing the explicit request', async (t) => {
  const userData = fixture(t)
  let release,
    started,
    downloads = 0
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const scraper = createScraper({
    userData,
    logger: { log() {} },
    getPreferences: () => ({
      downloadCovers: false,
      downloadBackgrounds: false,
      downloadVideos: false,
      downloadAudio: true
    }),
    fetchImpl: async (url) => {
      if (url.includes('advancedsearch'))
        return Response.json({
          response: { docs: [{ identifier: 'blur-ost', title: 'Blur Soundtrack' }] }
        })
      if (url.includes('/metadata/'))
        return Response.json({ files: [{ name: 'theme.mp3', size: 131 }] })
      downloads++
      if (downloads === 1) {
        started()
        await gate
      }
      return new Response(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(128, downloads)]))
    }
  })
  const game = { fileName: 'Blur.iso', systemShort: 'PS3' }
  await scraper.scan([game])
  await ready
  let finished = false
  const retry = scraper.rescrape([game], scraper.enrich(game).gameId).then((result) => {
    finished = true
    return result
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(finished, false)
  release()
  const result = await retry
  assert.equal(downloads, 2)
  assert.equal(fs.readFileSync(result.game.media.music)[130], 2)
})

test('same-path media replacement creates a fresh renderer URL', (t) => {
  const userData = fixture(t),
    file = path.join(userData, 'boxart.png')
  fs.writeFileSync(file, png)
  const old = mediaUrl(file)
  const timestamp = new Date(Date.now() + 10000)
  fs.utimesSync(file, timestamp, timestamp)
  assert.notEqual(mediaUrl(file), old)
})

test('manual retry bypasses another game waiting in the automatic preview queue', async (t) => {
  const userData = fixture(t)
  let release, started
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const scraper = createScraper({
    userData,
    logger: { log() {} },
    getPreferences: () => ({
      downloadCovers: false,
      downloadBackgrounds: false,
      downloadVideos: false,
      downloadAudio: true
    }),
    fetchImpl: async (url) => {
      if (url.includes('advancedsearch')) {
        const other = new URL(url).searchParams.get('q').includes('Other')
        return Response.json({
          response: {
            docs: [
              {
                identifier: other ? 'other' : 'blur',
                title: (other ? 'Other' : 'Blur') + ' Soundtrack'
              }
            ]
          }
        })
      }
      if (url.includes('/metadata/'))
        return Response.json({ files: [{ name: 'theme.mp3', size: 131 }] })
      if (url.includes('/download/other/')) {
        started()
        await gate
      }
      return new Response(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(128)]))
    }
  })
  const games = ['Other.iso', 'Blur.iso'].map((fileName) => ({ fileName, systemShort: 'PS2' }))
  await scraper.scan(games)
  await ready
  let timer
  try {
    const result = await Promise.race([
      scraper.rescrape(games, scraper.enrich(games[1]).gameId),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Manual retry stuck behind unrelated game')), 1500)
      })
    ])
    assert(result.game.media.music)
  } finally {
    clearTimeout(timer)
    release()
    await scraper.whenMediaIdle()
  }
})

test('enabling backgrounds is not suppressed by the earlier cover-only cooldown', async (t) => {
  const userData = fixture(t),
    calls = [],
    preferences = {
      downloadCovers: true,
      downloadBackgrounds: false,
      downloadVideos: false,
      downloadAudio: false
    }
  const scraper = createScraper({
    userData,
    getPreferences: () => preferences,
    logger: { log() {} },
    fetchImpl: async (url) => {
      calls.push(url)
      return new Response(url.endsWith('/') ? '<a href="Blur.png">Blur</a>' : png)
    }
  })
  const games = [{ fileName: 'Blur.iso', systemShort: 'PS2' }]
  await scraper.scan(games)
  assert(!calls.some((url) => url.includes('Named_Snaps')))
  preferences.downloadBackgrounds = true
  const result = await scraper.scan(games)
  assert(result.games[0].media.snap)
  assert(calls.some((url) => url.includes('Named_Snaps')))
})
test('media preferences persist across restarts and concurrent hotkey patches', async (t) => {
  const userData = fixture(t),
    store = createPreferences(userData)
  await Promise.all([
    store.update({ media: { onlineImages: false, onlineVideos: false } }),
    store.update({ hotkeys: { keyboard: ['KeyQ', 'KeyE'] } })
  ])
  const reloaded = createPreferences(userData).get()
  assert.deepEqual(mediaPreferences(reloaded.media), {
    downloadCovers: false,
    downloadBackgrounds: false,
    downloadVideos: false,
    downloadAudio: true
  })
  assert.deepEqual(reloaded.hotkeys.keyboard, ['KeyQ', 'KeyE'])
  assert.deepEqual(mediaPreferences({ onlineImages: 'false' }), MEDIA_DEFAULTS)
  assert(Object.values(mediaPreferences()).every((enabled) => enabled === true))
})
test('real bundled 7-Zip extracts PS3 ISO offline and reuses cache', async (t) => {
  const userData = fixture(t),
    file = path.join(userData, 'Blur (PS3).iso')
  fs.writeFileSync(file, ps3MediaIso(png))
  const scraper = createScraper({
    userData,
    getPreferences: () => ({ onlineImages: false, onlineVideos: false }),
    fetchImpl: async () => {
      throw Error('offline')
    }
  })
  const game = { fileName: path.basename(file), path: file, systemShort: 'PS3' }
  const result = await scraper.scan([game])
  await scraper.whenMediaIdle()
  for (const kind of ['boxart', 'snap'])
    assert.deepEqual(fs.readFileSync(result.games[0].media[kind]), png)
  let calls = 0
  await createPs3IsoExtractor({
    userData,
    executeImpl: () => {
      calls++
      throw Error('must use cache')
    }
  })(scraper.enrich(game))
  assert.equal(calls, 0)
})
test('both switches suppress their requests even during forced PS3 rescan; local media survives', async (t) => {
  const userData = fixture(t),
    calls = [],
    prefs = { onlineImages: false, onlineVideos: false }
  const scraper = createScraper({
    userData,
    getPreferences: () => prefs,
    fetchImpl: async (url) => {
      calls.push(url)
      return new Response('', { status: 404 })
    }
  })
  const game = { fileName: 'Blur.iso', systemShort: 'PS3' },
    enriched = scraper.enrich(game)
  fs.mkdirSync(enriched.mediaDirectory, { recursive: true })
  fs.writeFileSync(path.join(enriched.mediaDirectory, 'theme.mp3'), 'local audio')
  fs.writeFileSync(path.join(enriched.mediaDirectory, 'boxart.png'), png)
  await scraper.scan([game])
  await scraper.whenMediaIdle()
  assert.equal(calls.length, 0)
  await scraper.scan([game], undefined, { force: true, gameId: enriched.gameId })
  await scraper.whenMediaIdle()
  assert(
    calls.every((url) => /vgm_ost|mediatype%3Aaudio/.test(url)),
    'Independent existing music policy is unchanged'
  )
  assert.equal(scraper.enrich(game).media.boxart, path.join(enriched.mediaDirectory, 'boxart.png'))
  calls.length = 0
  prefs.onlineImages = true
  await scraper.scan([game], undefined, { force: true })
  await scraper.whenMediaIdle()
  assert(calls.some((url) => url.includes('thumbnails.libretro.com')))
  assert(!calls.some((url) => /video|movies|gameplay/.test(url)))
  calls.length = 0
  prefs.onlineImages = false
  prefs.onlineVideos = true
  await scraper.scan([game], undefined, { force: true })
  await scraper.whenMediaIdle()
  assert(calls.some((url) => /video/.test(url)))
  assert(!calls.some((url) => /thumbnails|mediatype%3Aimage/.test(url)))
})
test('disabling images aborts a pending CDN request and skips later requests', async (t) => {
  const userData = fixture(t),
    prefs = { onlineImages: true, onlineVideos: false }
  let start,
    aborted = false,
    calls = 0
  const ready = new Promise((resolve) => {
    start = resolve
  })
  const scraper = createScraper({
    userData,
    getPreferences: () => prefs,
    fetchImpl: async (url, { signal }) => {
      if (!url.includes('thumbnails')) return new Response('', { status: 404 })
      calls++
      start()
      return new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(Error('aborted'))
          },
          { once: true }
        )
      )
    }
  })
  const scan = scraper.scan([{ fileName: 'Game.iso', systemShort: 'PS2' }])
  await ready
  prefs.onlineImages = false
  scraper.cancelDisabledRequests()
  await scan
  await scraper.whenMediaIdle()
  assert(aborted)
  assert.equal(calls, 1)
})
test('HD artwork prefers 4K candidates, validates dimensions, and preserves cache on failed refresh', async (t) => {
  const userData = fixture(t),
    requests = [],
    hd = Buffer.from(png)
  hd.writeUInt32BE(3840, 16)
  hd.writeUInt32BE(2160, 20)
  const game = { gameId: 'ps3-blur-test', title: 'Blur', systemShort: 'PS3' }
  let fail = false
  const provider = createMediaDownloader({
    userData,
    fetchImpl: async (url) => {
      requests.push(url)
      if (fail) throw Error('offline')
      if (url.includes('advancedsearch'))
        return Response.json({
          response: { docs: [{ identifier: 'blur-art', title: 'Blur Fanart' }] }
        })
      if (url.includes('/metadata/'))
        return Response.json({
          files: [
            { name: 'small.png', width: 320, height: 180 },
            { name: '4k.png', width: 3840, height: 2160 }
          ]
        })
      return new Response(hd)
    }
  })
  const result = await provider(game, { kinds: ['fanart'] })
  assert(result.fanart?.endsWith('fanart.png'))
  assert(requests.at(-1).endsWith('/4k.png'))
  fail = true
  provider.clearCatalogs()
  const failed = await provider(game, { kinds: ['fanart'], force: true })
  assert.deepEqual(fs.readFileSync(result.fanart), hd)
  assert.equal(failed.fanart, null, 'Failure is silent; enrichment still exposes preserved cache')
})
