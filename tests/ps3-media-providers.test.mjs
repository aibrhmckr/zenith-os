import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPs3IsoExtractor, cachedPs3IsoTitleId } from '../src/main/services/ps3IsoMedia.js'
import { createMediaDownloader } from '../src/main/services/mediaScraper.js'
import { createScraper } from '../src/main/services/scraper.js'
import { paramSfo } from './fixtures/ps3-sfo.cjs'
import { ps3MediaIso } from './fixtures/ps3-media-iso.cjs'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=',
  'base64'
)
// Synthetic JPEG header for the bounded format validator; no copyrighted image.
const jpeg = Buffer.from([
  255, 216, 255, 192, 0, 17, 8, 3, 132, 2, 88, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217
])
function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-ps3-providers-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  return userData
}
const quiet = { log() {} }
const listing = {
  stdout: ['ICON0.PNG', 'PIC1.PNG', 'PARAM.SFO', 'PS3_DISC.SFB']
    .map((name) => `Path = PS3_GAME/${name}\nSize = 1024`)
    .join('\n\n')
}

test('explicit rescrape retries an unreadable title ID despite cached images; SFB fallback normalizes it', async (t) => {
  const userData = fixture(t),
    game = { gameId: 'ps3-retry', systemShort: 'PS3', path: path.join(userData, 'Demo.iso') }
  fs.writeFileSync(game.path, 'synthetic disc')
  let calls = 0
  const extract = createPs3IsoExtractor({
    userData,
    logger: quiet,
    executeImpl: async (_binary, args) => {
      if (args[0] === 'l') return listing
      calls++
      const output = args.find((arg) => arg.startsWith('-o')).slice(2)
      fs.writeFileSync(path.join(output, 'ICON0.PNG'), png)
      fs.writeFileSync(path.join(output, 'PIC1.PNG'), png)
      if (calls > 1) fs.writeFileSync(path.join(output, 'PS3_DISC.SFB'), 'TITLE_ID\0BLUS-30127\0')
    }
  })
  await extract(game)
  assert.equal(cachedPs3IsoTitleId(userData, game), null)
  await extract(game, { force: true })
  assert.equal(cachedPs3IsoTitleId(userData, game), 'BLUS30127')
  await extract(game)
  assert.equal(calls, 2)
})

test('7-Zip uses temporary flat extraction, accepts valid members after Headers Error and cleans up', async (t) => {
  const userData = fixture(t),
    game = { gameId: 'ps3-demo', systemShort: 'PS3', path: path.join(userData, 'Demo.iso') }
  fs.writeFileSync(game.path, 'synthetic ISO')
  let output
  const logs = []
  await createPs3IsoExtractor({
    userData,
    logger: { log: (message) => logs.push(message) },
    executeImpl: async (_binary, args) => {
      if (args[0] === 'l') return listing
      assert.equal(args[0], 'e')
      assert(!args.includes('-so'))
      assert(args.includes('-r') && args.includes('-ssc-'))
      output = args.find((arg) => arg.startsWith('-o')).slice(2)
      fs.writeFileSync(path.join(output, 'icon0.png'), png)
      fs.writeFileSync(path.join(output, 'PiC1.PnG'), png)
      fs.writeFileSync(path.join(output, 'param.sfo'), paramSfo({ TITLE_ID: 'BLUS30127' }))
      throw Error('Headers Error')
    }
  })(game)
  assert(!fs.existsSync(output))
  for (const name of ['embedded-icon0.png', 'embedded-pic1.png'])
    assert.deepEqual(fs.readFileSync(path.join(userData, 'media', game.gameId, name)), png)
  assert.equal(cachedPs3IsoTitleId(userData, game), 'BLUS30127')
  assert(!logs.some((message) => /Headers Error|Arşiv uyarısı/.test(message)))
  assert(logs.some((message) => message.includes('Title ID: BLUS30127')))
})

test('partial artwork or title ID extraction silences UDF warnings from stderr/stdout', async (t) => {
  for (const member of ['ICON0.PNG', 'PARAM.SFO']) {
    const userData = fixture(t)
    const game = { gameId: 'partial', systemShort: 'PS3', path: path.join(userData, 'Demo.iso') }
    fs.writeFileSync(game.path, 'synthetic ISO')
    const logs = []
    await createPs3IsoExtractor({
      userData,
      logger: { log: (message) => logs.push(message) },
      executeImpl: async (_binary, args) => {
        if (args[0] === 'l') return listing
        const output = args.find((arg) => arg.startsWith('-o')).slice(2)
        fs.writeFileSync(
          path.join(output, member),
          member === 'ICON0.PNG' ? png : paramSfo({ TITLE_ID: 'BLUS31584' })
        )
        throw Object.assign(Error('Command failed: 7z'), {
          code: 2,
          [member === 'ICON0.PNG' ? 'stderr' : 'stdout']: 'ERRORS:\nHeaders Error\n'
        })
      }
    })(game)
    assert(!logs.some((message) => /Headers Error|Arşiv uyarısı/.test(message)))
    if (member === 'PARAM.SFO') assert.equal(cachedPs3IsoTitleId(userData, game), 'BLUS31584')
    else
      assert.deepEqual(
        fs.readFileSync(path.join(userData, 'media', game.gameId, 'embedded-icon0.png')),
        png
      )
    assert(
      !fs
        .readdirSync(path.join(userData, 'media', game.gameId))
        .some((name) => name.startsWith('.iso-extract-'))
    )
  }
})

test('no extracted targets rejects even after a zero exit or with a title ID filename hint', async (t) => {
  for (const warning of [false, true]) {
    const userData = fixture(t)
    const game = {
      gameId: 'empty',
      fileName: 'BLUS31584.iso',
      systemShort: 'PS3',
      path: path.join(userData, 'BLUS31584.iso')
    }
    fs.writeFileSync(game.path, 'synthetic ISO')
    let output
    const extract = createPs3IsoExtractor({
      userData,
      logger: quiet,
      executeImpl: async (_binary, args) => {
        if (args[0] === 'l') return listing
        output = args.find((arg) => arg.startsWith('-o')).slice(2)
        if (warning) throw Error('Headers Error')
      }
    })
    await assert.rejects(extract(game), { code: 'PS3_ISO_EXTRACTION_FAILED' })
    assert(!fs.existsSync(output))
    assert(!fs.existsSync(path.join(userData, 'media', game.gameId, 'embedded-source.json')))
    assert.equal(cachedPs3IsoTitleId(userData, game), null)
  }
})

test('failed ISO extraction cleans its temporary tree and never publishes invalid image data', async (t) => {
  const userData = fixture(t),
    game = { gameId: 'ps3-bad', systemShort: 'PS3', path: path.join(userData, 'Bad.iso') }
  fs.writeFileSync(game.path, 'bad ISO')
  let output
  const extract = createPs3IsoExtractor({
    userData,
    logger: quiet,
    executeImpl: async (_binary, args) => {
      if (args[0] === 'l') return listing
      output = args.find((arg) => arg.startsWith('-o')).slice(2)
      fs.writeFileSync(path.join(output, 'ICON0.PNG'), '<html>not an image</html>')
      throw Error('timeout')
    }
  })
  await assert.rejects(extract(game), { code: 'PS3_ISO_EXTRACTION_FAILED' })
  assert(!fs.existsSync(output))
  assert(!fs.existsSync(path.join(userData, 'media', game.gameId, 'embedded-icon0.png')))
})

test('real 7-Zip recursive extraction tolerates alternate directories and lowercase member names', async (t) => {
  const userData = fixture(t)
  const game = { gameId: 'ps3-case', systemShort: 'PS3', path: path.join(userData, 'Case.iso') }
  const iso = ps3MediaIso(png)
  for (const [from, to] of [
    ['PS3_GAME', 'alt_game'],
    ['ICON0.PNG', 'icon0.png'],
    ['PIC1.PNG', 'pic1.png']
  ]) {
    const offset = iso.indexOf(from)
    assert(offset >= 0)
    iso.write(to, offset, 'ascii')
  }
  fs.writeFileSync(game.path, iso)
  await createPs3IsoExtractor({ userData, logger: quiet })(game)
  for (const name of ['embedded-icon0.png', 'embedded-pic1.png'])
    assert.deepEqual(fs.readFileSync(path.join(userData, 'media', game.gameId, name)), png)
  assert(
    !fs
      .readdirSync(path.join(userData, 'media', game.gameId))
      .some((name) => name.startsWith('.iso-extract-'))
  )
})

test('real ISO PARAM.SFO feeds GameTDB on the first scan; cover download can be disabled', async (t) => {
  const userData = fixture(t),
    file = path.join(userData, 'Demo (PS3).iso'),
    calls = []
  fs.writeFileSync(file, ps3MediaIso(png, paramSfo({ TITLE_ID: 'BLUS30127', TITLE: 'Demo' })))
  const prefs = {
    downloadCovers: true,
    downloadBackgrounds: false,
    downloadVideos: false,
    downloadAudio: false
  }
  const scraper = createScraper({
    userData,
    logger: quiet,
    getPreferences: () => prefs,
    fetchImpl: async (url) => {
      calls.push(url)
      return url.includes('art.gametdb.com')
        ? new Response(jpeg)
        : new Response('', { status: 404 })
    }
  })
  const game = { fileName: path.basename(file), path: file, systemShort: 'PS3' }
  await scraper.scan([game])
  await scraper.whenMediaIdle()
  assert(calls.includes('https://art.gametdb.com/ps3/cover/US/BLUS30127.jpg'))
  assert.equal(scraper.enrich(game).titleId, 'BLUS30127')
  assert(scraper.enrich(game).media.boxart.endsWith('cover-gametdb.jpg'))
  calls.length = 0
  prefs.downloadCovers = false
  await scraper.rescrape([game], scraper.enrich(game).gameId)
  assert.equal(calls.length, 0)
  assert(scraper.enrich(game).media.boxart.endsWith('cover-gametdb.jpg'))
})

test('GameTDB retries US/EN/JA, rejects invalid content and retains old cover on failed refresh', async (t) => {
  const userData = fixture(t),
    calls = [],
    game = { gameId: 'ps3-demo', systemShort: 'PS3', title: 'Demo', titleId: 'BLES00148' }
  let fail = false
  const provider = createMediaDownloader({
    userData,
    fetchImpl: async (url) => {
      calls.push(url)
      if (url.includes('/US/')) return new Response('', { status: 404 })
      if (url.includes('/EN/')) return new Response('<html>error</html>')
      if (url.includes('/JA/') && !fail) return new Response(jpeg)
      return new Response('', { status: 404 })
    }
  })
  const result = await provider(game, { kinds: ['boxart'] })
  assert.deepEqual(
    calls.map((url) => url.split('/').at(-2)),
    ['US', 'EN', 'JA']
  )
  assert(result.boxart.endsWith('cover-gametdb.jpg'))
  fail = true
  await provider(game, { kinds: ['boxart'], force: true })
  assert.deepEqual(fs.readFileSync(result.boxart), jpeg)
  assert(!fs.existsSync(result.boxart + '.part'))
  calls.length = 0
  await provider(
    { ...game, gameId: 'ps3-invalid', titleId: '../../secret' },
    { kinds: ['boxart'], force: true }
  )
  assert(!calls.some((url) => url.includes('gametdb')))
})

test('PS3 probes both named Archive packs before generic search and matches title IDs', async (t) => {
  const userData = fixture(t),
    calls = [],
    video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(48)])
  const provider = createMediaDownloader({
    userData,
    fetchImpl: async (url) => {
      calls.push(url)
      if (url.endsWith('/metadata/sony-playstation-3-video-snaps'))
        return new Response('', { status: 404 })
      if (url.endsWith('/metadata/SonyPlaystation3VideoSnaps'))
        return Response.json({
          files: [
            { name: 'Wrong Game.mp4', size: video.length },
            { name: 'BLUS30127.mp4', size: video.length, length: '0:30' }
          ]
        })
      if (url.endsWith('/download/SonyPlaystation3VideoSnaps/BLUS30127.mp4'))
        return new Response(video)
      throw Error('Unexpected discovery request: ' + url)
    }
  })
  const result = await provider(
    { gameId: 'ps3-video', title: 'Demo', titleId: 'BLUS30127', systemShort: 'PS3' },
    { kinds: ['video'] }
  )
  assert(result.video?.endsWith('preview.mp4'))
  assert.equal(calls.length, 3)
  assert.deepEqual(fs.readFileSync(result.video), video)
})
