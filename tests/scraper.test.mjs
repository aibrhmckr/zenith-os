import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGameName, createScraper, gameMediaId } from '../src/main/services/scraper.js'
import { mediaUrl, serveMedia } from '../src/main/services/local-media.js'
import { createMediaDownloader } from '../src/main/services/mediaScraper.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=',
  'base64'
)
const fixture = () => {
  const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-scraper-test-'))
  return { projectDirectory, userData: path.join(projectDirectory, 'profile') }
}
const game = (fileName = 'Call of Duty 3 (USA).iso', systemShort = 'PS2') => ({
  id: fileName,
  fileName,
  systemShort
})

test('clean title/region and stable collision-resistant IDs preserve significant punctuation', () => {
  assert.deepEqual(cleanGameName('Call of Duty 3 (USA).iso'), {
    title: 'Call of Duty 3',
    region: 'USA'
  })
  assert.deepEqual(cleanGameName('New Super Mario Bros. (USA).nds'), {
    title: 'New Super Mario Bros.',
    region: 'USA'
  })
  assert.deepEqual(cleanGameName('Game (Europe) (En,Fr) [!].ISO'), {
    title: 'Game',
    region: 'Europe'
  })
  assert.equal(gameMediaId(game()), gameMediaId(game()))
  assert.notEqual(gameMediaId(game()), gameMediaId(game('Call of Duty 3 (Europe).iso')))
  assert.notEqual(gameMediaId(game()), gameMediaId(game('Call of Duty 3 (USA).iso', 'PSP')))
  assert.match(gameMediaId(game('../../bad.iso')), /^[a-z0-9-]+$/)
})

test('all three CDN categories, region matching, cache persistence, local audio/video and offline reuse', async () => {
  const paths = fixture()
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('/'))
      return new Response(
        [
          '<a href="Call%20of%20Duty%203%20(Europe).png">Europe</a>',
          '<a href="Call%20of%20Duty%203%20(USA).png">USA</a>',
          '<a href="https://other.example/Call%20of%20Duty%203%20(USA).png">external</a>'
        ].join('')
      )
    assert.match(
      url,
      /thumbnails\.libretro\.com\/Sony%20-%20PlayStation%202\/Named_(Boxarts|Snaps|Titles)\/Call%20of%20Duty%203%20\(USA\)\.png$/
    )
    return new Response(png)
  }
  const scraper = createScraper({ ...paths, fetchImpl })
  const id = gameMediaId(game())
  fs.mkdirSync(path.join(paths.userData, 'media', id), { recursive: true })
  fs.mkdirSync(path.join(paths.userData, 'media', id), { recursive: true })
  fs.writeFileSync(path.join(paths.userData, 'media', id, 'theme.mp3'), 'local audio')
  fs.writeFileSync(path.join(paths.userData, 'media', id, 'preview.mp4'), 'local video')
  const updates = []
  const [result, duplicate] = await Promise.all([
    scraper.scan([game()], (p) => updates.push(p)),
    scraper.scan([game()])
  ])
  assert.equal(calls.length, 6, 'Concurrent scans share work')
  assert.deepEqual(result, duplicate)
  assert.equal(updates.at(-1).completed, 1)
  const enriched = result.games[0]
  for (const key of ['boxart', 'snap', 'titleScreen'])
    assert.deepEqual(fs.readFileSync(enriched.media[key]), png)
  assert(enriched.media.music.endsWith('theme.mp3'))
  assert(enriched.media.video.endsWith('preview.mp4'))
  const saved = JSON.parse(fs.readFileSync(path.join(paths.userData, 'games.json'))).games[id]
  assert.equal(saved.title, 'Call of Duty 3')
  assert.equal(saved.region, 'USA')
  assert.equal(saved.year, null, 'Thumbnail CDN does not supply release metadata')
  const offline = createScraper({
    ...paths,
    fetchImpl: () => {
      throw Error('Must use cached images')
    }
  })
  assert.equal((await offline.scan([game()], undefined, { force: true })).warning, null)
  assert.equal(offline.enrich(game()).media.boxart, enriched.media.boxart)
})

test('unmatched artwork, network failure, invalid images and oversized responses keep the library usable', async () => {
  for (const scenario of ['missing', 'offline', 'html', 'oversized']) {
    const paths = fixture()
    const scraper = createScraper({
      ...paths,
      fetchImpl: async (url) => {
        if (scenario === 'offline') throw Error('offline')
        if (scenario === 'missing') return new Response('', { status: 404 })
        if (url.endsWith('/'))
          return new Response('<a href="Call%20of%20Duty%203%20(USA).png">art</a>')
        return new Response(
          'not a png',
          scenario === 'oversized' ? { headers: { 'content-length': '99999999' } } : undefined
        )
      }
    })
    const result = await scraper.scan([game()])
    assert.equal(result.games.length, 1)
    assert.equal(result.games[0].media.boxart, null)
    assert.equal(Boolean(result.warning), scenario !== 'missing')
    assert(fs.existsSync(path.join(paths.userData, 'games.json')))
    await scraper.whenMediaIdle()
  }
})

test('Game Boy uses its own archive despite shared GBC library filter; failed scans are retried', async () => {
  const paths = fixture()
  let fail = true
  const urls = []
  const scraper = createScraper({
    ...paths,
    fetchImpl: async (url) => {
      if (!url.includes('thumbnails.libretro.com')) return new Response('', { status: 404 })
      urls.push(url)
      if (fail) throw Error('offline')
      return new Response('')
    }
  })
  await scraper.scan([game('Tetris.gb', 'GBC')])
  fail = false
  await scraper.scan([game('Tetris.gb', 'GBC')])
  assert(urls.length > 1)
  assert(urls.every((url) => url.includes('Nintendo%20-%20Game%20Boy/')))
  await scraper.whenMediaIdle()
})

const archive = 'https://archive.org'
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1024)])
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(1012)])
const musicFiles = [
  { name: 'Huge Theme.mp3', size: 6 * 1024 * 1024 },
  { name: '01 - Battle.mp3', size: mp3.length, length: '1:30' },
  { name: '02 - Title & Theme.mp3', size: mp3.length, length: '0:30' }
]
const videoFiles = [
  { name: 'Call of Duty 30 (USA).mp4', size: mp4.length, length: '30' },
  { name: 'Call of Duty 3 (Europe).mp4', size: mp4.length, length: '30' },
  {
    name: 'Call of Duty 3 (USA).ia.mp4',
    original: 'Call of Duty 3 (USA).mp4',
    size: mp4.length,
    length: '30'
  }
]
const mediaFixture = () => {
  const paths = fixture()
  const enriched = createScraper(paths).enrich(game())
  return { ...paths, enriched }
}
const downloadMedia = (game, options = {}, settings) =>
  createMediaDownloader({ userData: path.dirname(path.dirname(game.mediaDirectory)), ...options })(
    game,
    settings
  )
const archiveFetch =
  ({
    music = () => new Response(mp3),
    video = () => new Response(mp4),
    calls = [],
    primaryEmpty = false,
    files = {}
  } = {}) =>
  async (url, options) => {
    calls.push(url)
    const parsed = new URL(url)
    if (parsed.hostname === 'thumbnails.libretro.com') return new Response('', { status: 404 })
    assert.equal(parsed.origin, archive, 'Only Archive.org serves preview media')
    if (parsed.pathname === '/advancedsearch.php') {
      const q = parsed.searchParams.get('q')
      const docs = q.includes('video snaps')
        ? [{ identifier: 'ps2-snaps', title: 'Sony Playstation 2 (Video Snaps)' }]
        : q.includes('mediatype:movies') || (primaryEmpty && q.includes('vgm_ost'))
          ? []
          : [{ identifier: 'cod3-ost', title: 'Call of Duty 3 Soundtrack (2006)' }]
      return Response.json({ response: { docs } })
    }
    if (parsed.pathname === '/metadata/cod3-ost')
      return Response.json({ files: files.music || musicFiles })
    if (parsed.pathname === '/metadata/ps2-snaps')
      return Response.json({ files: files.video || videoFiles })
    if (parsed.pathname.startsWith('/download/cod3-ost/')) return music(options)
    if (parsed.pathname.startsWith('/download/ps2-snaps/')) return video(options)
    throw Error(`Unexpected request ${url}`)
  }
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const manifest = (paths) =>
  JSON.parse(fs.readFileSync(path.join(paths.userData, 'games.json'))).games

test('Archive search/metadata select title MP3 and matching short regional MP4, then cache atomically', async () => {
  const { enriched } = mediaFixture()
  const calls = []
  const updates = []
  const fetchImpl = archiveFetch({
    calls,
    music: () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(mp3.subarray(0, 1))
            c.enqueue(mp3.subarray(1))
            c.close()
          }
        })
      )
  })
  const media = await downloadMedia(
    enriched,
    { fetchImpl },
    { onResult: (kind, file) => updates.push({ kind, file }) }
  )
  assert.deepEqual(fs.readFileSync(media.music), mp3)
  assert.deepEqual(fs.readFileSync(media.video), mp4)
  assert.equal(media.music, path.join(enriched.mediaDirectory, 'theme.mp3'))
  assert.equal(media.video, path.join(enriched.mediaDirectory, 'preview.mp4'))
  assert.equal(fs.existsSync(`${media.music}.part`), false)
  assert.equal(fs.existsSync(`${media.video}.part`), false)
  assert.equal(updates.length, 2)
  const search = calls
    .map((url) => new URL(url))
    .find((url) => url.searchParams.get('q')?.includes('vgm_ost'))
  assert.equal(search.searchParams.get('q'), 'collection:(vgm_ost) AND title:("Call of Duty 3")')
  assert(calls.some((url) => decodeURIComponent(url).endsWith('/02 - Title & Theme.mp3')))
  assert(calls.some((url) => decodeURIComponent(url).endsWith('/Call of Duty 3 (USA).ia.mp4')))
  const count = calls.length
  await downloadMedia(enriched, { fetchImpl })
  assert.equal(calls.length, count, 'Completed cache is reused offline')
})

test('theme names containing underscores win; without a theme the first MP3 is used', async () => {
  for (const theme of [true, false]) {
    const { enriched } = mediaFixture()
    const calls = []
    const files = [
      { name: '01_Battle.mp3', size: mp3.length },
      { name: theme ? '02_main_theme.mp3' : '02_Battle.mp3', size: mp3.length }
    ]
    const result = await downloadMedia(
      enriched,
      { fetchImpl: archiveFetch({ calls, files: { music: files } }) },
      { kinds: ['music'] }
    )
    assert(result.music)
    assert(calls.at(-1).endsWith(theme ? '/02_main_theme.mp3' : '/01_Battle.mp3'))
  }
})

test('empty vgm_ost falls back to public audio items; short individual video is a pack fallback', async () => {
  const { enriched } = mediaFixture()
  const calls = []
  const base = archiveFetch({ calls, primaryEmpty: true })
  const result = await downloadMedia(enriched, {
    fetchImpl: async (url, options) => {
      const q = new URL(url).searchParams.get('q')
      if (q?.includes('video snaps')) return Response.json({ response: { docs: [] } })
      if (q?.includes('mediatype:movies'))
        return Response.json({
          response: { docs: [{ identifier: 'cod3-clip', title: 'Call of Duty 3 Preview' }] }
        })
      if (url.endsWith('/metadata/cod3-clip'))
        return Response.json({ files: [{ name: 'clip.mp4', size: mp4.length, length: '0:25' }] })
      if (url.endsWith('/download/cod3-clip/clip.mp4')) return new Response(mp4)
      return base(url, options)
    }
  })
  assert(result.music && result.video)
  assert(calls.some((url) => new URL(url).searchParams.get('q')?.includes('mediatype:audio')))
})

test('unrelated albums, sequels, private files, long videos and unsafe names are never downloaded', async () => {
  const { enriched } = mediaFixture()
  const calls = []
  const base = archiveFetch({
    calls,
    files: {
      video: [
        { name: 'Call of Duty 3.mp4', length: '61', size: 100 },
        { name: 'Call of Duty 3 (USA).mp4', private: 'true', size: 100 },
        { name: '../Call of Duty 3.mp4', size: 100 },
        { name: 'Call of Duty 3 (Europe).mp4', size: 6 * 1024 * 1024 },
        { name: 'Call of Duty 30.mp4', size: 100 }
      ]
    }
  })
  const result = await downloadMedia(enriched, {
    fetchImpl: (url, options) =>
      new URL(url).searchParams.get('q')?.includes('vgm_ost')
        ? Response.json({
            response: { docs: [{ identifier: 'other', title: 'Call of Duty 30 Soundtrack' }] }
          })
        : base(url, options)
  })
  assert.deepEqual(result, { music: null, video: null })
  assert(!calls.some((url) => url.includes('/download/')))
})

test('audio and video stream limits, timeout/body timeout, bad JSON/format, and network failures are silent', async () => {
  for (const kind of ['music', 'video']) {
    for (const scenario of [
      '404',
      '403',
      'offline',
      'timeout',
      'body-timeout',
      'header-limit',
      'stream-limit',
      'html',
      'empty',
      'disconnect'
    ]) {
      const { enriched } = mediaFixture()
      const bytes = kind === 'music' ? mp3 : mp4
      const failure = async ({ signal }) => {
        if (scenario === '404' || scenario === '403')
          return new Response('', { status: Number(scenario) })
        if (scenario === 'offline') throw Error('offline')
        if (scenario === 'timeout')
          return new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(Error('timeout')), { once: true })
          )
        if (scenario === 'body-timeout')
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(bytes)
                signal.addEventListener('abort', () => c.error(Error('body timeout')), {
                  once: true
                })
              }
            })
          )
        if (scenario === 'header-limit')
          return new Response(bytes, { headers: { 'content-length': '6000000' } })
        if (scenario === 'stream-limit')
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(bytes)
                c.enqueue(Buffer.alloc(5 * 1024 * 1024))
                c.close()
              }
            })
          )
        if (scenario === 'html') return new Response('<html>Unavailable</html>')
        if (scenario === 'empty') return new Response('')
        return new Response(
          new ReadableStream({
            pull(c) {
              c.error(Error('disconnected'))
            }
          })
        )
      }
      const result = await downloadMedia(enriched, {
        timeoutMs: 30,
        fetchImpl: archiveFetch({ [kind]: failure })
      })
      assert.equal(result[kind], null, `${kind}: ${scenario}`)
      assert(result[kind === 'music' ? 'video' : 'music'], 'Other medium succeeds independently')
      const target = path.join(
        enriched.mediaDirectory,
        kind === 'music' ? 'theme.mp3' : 'preview.mp4'
      )
      assert.equal(fs.existsSync(target), false)
      assert.equal(fs.existsSync(`${target}.part`), false)
    }
  }
  const { enriched } = mediaFixture()
  assert.deepEqual(
    await downloadMedia(enriched, { fetchImpl: async () => new Response('not json') }),
    { music: null, video: null }
  )
})

test('slow video never blocks a scan or music event; overlapping refreshes deduplicate both downloads', async () => {
  const paths = fixture()
  const gate = deferred()
  const updates = []
  const calls = []
  const musicReady = deferred()
  const scraper = createScraper({
    ...paths,
    fetchImpl: archiveFetch({
      calls,
      video: async () => {
        await gate.promise
        return new Response(mp4)
      }
    }),
    onMediaUpdated: (game) => {
      updates.push(game)
      if (game.media.music) musicReady.resolve()
    }
  })
  let timer
  try {
    const result = await Promise.race([
      scraper.scan([game()]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Scan waited for preview')), 1000)
      })
    ])
    assert.equal(result.games[0].media.video, null)
    await musicReady.promise
    assert.equal(updates[0].media.video, null)
    assert(manifest(paths)[gameMediaId(game())].media.music)
    await scraper.scan([game()], undefined, { force: true })
    gate.resolve()
    await scraper.whenMediaIdle()
    assert.equal(calls.filter((url) => url.includes('/download/')).length, 2)
    const saved = manifest(paths)[gameMediaId(game())]
    assert(saved.media.music && saved.media.video)
    assert(saved.archiveCheckedAt.music && saved.archiveCheckedAt.video && saved.checkedAt)
    assert.equal(updates.at(-1).media.video, saved.media.video)
  } finally {
    clearTimeout(timer)
    gate.resolve()
    await scraper.whenMediaIdle()
  }
})

test('fast preview completion survives slower artwork writes without losing paths', async () => {
  const paths = fixture()
  const gate = deferred()
  const base = archiveFetch()
  const scraper = createScraper({
    ...paths,
    fetchImpl: async (url, options) => {
      if (!url.includes('thumbnails.libretro.com')) return base(url, options)
      await gate.promise
      return new Response(
        url.endsWith('/') ? '<a href="Call%20of%20Duty%203%20(USA).png">art</a>' : png
      )
    }
  })
  const scanning = scraper.scan([game()])
  await scraper.whenMediaIdle()
  gate.resolve()
  const result = await scanning
  const saved = manifest(paths)[gameMediaId(game())]
  for (const kind of ['music', 'video', 'boxart', 'snap', 'titleScreen']) assert(saved.media[kind])
  assert.deepEqual(result.games[0].media, saved.media)
})

test('userData game cache wins; legacy AppData paths work and project media is ignored', async () => {
  const paths = mediaFixture()
  const id = paths.enriched.gameId
  for (const [folder, name] of [
    ['music', 'mp3'],
    ['videos', 'mp4']
  ]) {
    for (const root of [paths.projectDirectory, paths.userData]) {
      const target = path.join(root, 'media', folder, `${id}.${name}`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, 'legacy')
    }
  }
  const calls = []
  const scraper = createScraper({ ...paths, fetchImpl: archiveFetch({ calls }) })
  assert.equal(
    scraper.enrich(game()).media.music,
    path.join(paths.userData, 'media', 'music', `${id}.mp3`)
  )
  for (const [kind, filename, bytes] of [
    ['music', 'theme.mp3', mp3],
    ['video', 'preview.mp4', mp4]
  ]) {
    fs.mkdirSync(paths.enriched.mediaDirectory, { recursive: true })
    fs.writeFileSync(path.join(paths.enriched.mediaDirectory, filename), bytes)
    assert.equal(
      scraper.enrich(game()).media[kind],
      path.join(paths.enriched.mediaDirectory, filename)
    )
  }
  await scraper.scan([game()])
  await scraper.whenMediaIdle()
  assert(calls.every((url) => url.includes('thumbnails.libretro.com')))
  const onlyProject = createScraper({
    userData: path.join(paths.projectDirectory, 'fresh-profile'),
    projectDirectory: paths.projectDirectory
  })
  assert.equal(onlyProject.enrich(game()).media.music, null)
  assert.equal(onlyProject.enrich(game()).media.video, null)
})

test('silent null fallbacks persist per-medium cooldowns, ignore old provider failures, and retry on refresh', async () => {
  const paths = fixture()
  fs.mkdirSync(paths.userData, { recursive: true })
  fs.writeFileSync(
    path.join(paths.userData, 'games.json'),
    JSON.stringify({ games: { [gameMediaId(game())]: { musicCheckedAt: Date.now() } } })
  )
  const calls = []
  const scraper = createScraper({
    ...paths,
    fetchImpl: async (url) => {
      calls.push(url)
      return Response.json({ response: { docs: [] } })
    }
  })
  await scraper.scan([game()])
  await scraper.whenMediaIdle()
  assert(calls.some((url) => new URL(url).searchParams.get('q')?.includes('vgm_ost')))
  const saved = manifest(paths)[gameMediaId(game())]
  assert.equal(saved.media.music, null)
  assert.equal(saved.media.video, null)
  assert(saved.archiveCheckedAt.music && saved.archiveCheckedAt.video)
  const count = calls.length
  await scraper.scan([game()])
  await scraper.whenMediaIdle()
  assert.equal(calls.length, count)
  await scraper.scan([game()], undefined, { force: true })
  await scraper.whenMediaIdle()
  assert(calls.length > count)
})

test('removed games stay removed while late media completes', async () => {
  const paths = fixture()
  const gate = deferred()
  const started = deferred()
  const updates = []
  const blocked = async () => {
    started.resolve()
    await gate.promise
    return new Response(mp3)
  }
  const scraper = createScraper({
    ...paths,
    fetchImpl: archiveFetch({
      music: blocked,
      video: async () => {
        await gate.promise
        return new Response(mp4)
      }
    }),
    onMediaUpdated: (game) => updates.push(game)
  })
  await scraper.scan([game()])
  await started.promise
  await scraper.scan([])
  gate.resolve()
  await scraper.whenMediaIdle()
  assert.deepEqual(manifest(paths), {})
  assert.equal(updates.length, 0)
})

test('Archive storage redirects work; off-site redirects and escaped search syntax are contained', async () => {
  for (const location of [
    'https://ia800001.us.archive.org/1/items/cod3-ost/theme.mp3',
    'https://evil.example/theme.mp3',
    'http://archive.org/download/a/b.mp3',
    'https://archive.org.evil.example/download/a/b.mp3'
  ]) {
    const { enriched } = mediaFixture()
    const calls = []
    const base = archiveFetch({
      music: () => new Response(null, { status: 302, headers: { location } })
    })
    const result = await downloadMedia(
      enriched,
      {
        fetchImpl: (url, options) => {
          calls.push(url)
          if (url === location) return new Response(mp3)
          return base(url, options)
        }
      },
      { kinds: ['music'] }
    )
    if (location.includes('ia800001.us.archive.org')) assert(result.music)
    else {
      assert.equal(result.music, null)
      assert(!calls.includes(location))
    }
  }
  const { enriched } = mediaFixture()
  let query
  await downloadMedia(
    { ...enriched, title: 'Game "X" \\ test' },
    {
      fetchImpl: async (url) => {
        query = new URL(url).searchParams.get('q')
        return Response.json({ response: { docs: [] } })
      }
    },
    { kinds: ['music'] }
  )
  assert.equal(query, 'mediatype:audio AND title:("Game \\"X\\" \\\\ test")')
})

test('local media protocol restricts paths and serves bounded ranges, suffixes and HEAD', async () => {
  const { projectDirectory } = fixture()
  const file = path.join(projectDirectory, 'sample.mp4')
  fs.writeFileSync(file, '0123456789')
  const url = mediaUrl(file)
  const get = (headers, method = 'GET') => serveMedia(new Request(url, { headers, method }))
  const partial = get({ range: 'bytes=2-4' })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), 'bytes 2-4/10')
  assert.equal(await partial.text(), '234')
  assert.equal(await get({ range: 'bytes=-3' }).text(), '789')
  assert.equal(get({ range: 'bytes=20-' }).status, 416)
  assert.equal(get({ range: 'bytes=2-1' }).status, 416)
  const head = get({}, 'HEAD')
  assert.equal(head.headers.get('content-length'), '10')
  assert.equal(await head.text(), '')
  assert.equal(serveMedia(new Request('game-media://local/../secret.mp4')).status, 404)
})
