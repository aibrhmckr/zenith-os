import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGuideService } from '../src/main/services/guideService.js'

const game = {
  gameId: 'ps2-call-of-duty-3-test',
  title: 'Call of Duty 3',
  systemShort: 'PS2',
  region: 'USA'
}
const fixture = () => ({ userData: fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-guide-')) })
const jpeg = Buffer.from([255, 216, 255, 224, 0, 10, 20, 30])
const summary = {
  type: 'standard',
  title: 'Call of Duty 3',
  description: '2006 video game',
  extract:
    'Call of Duty 3 is a 2006 first-person shooter game developed by Treyarch and published by Activision.\nDo not show this extra paragraph.',
  titles: { canonical: 'Call_of_Duty_3' }
}
const id = 'ps2_Call_of_Duty_3_USA'
const fakeArchive =
  (calls = []) =>
  async (url) => {
    calls.push(url)
    const parsed = new URL(url)
    if (parsed.hostname === 'en.wikipedia.org') return Response.json(summary)
    if (parsed.pathname === '/advancedsearch.php')
      return Response.json({
        response: {
          docs: [
            { identifier: 'wrong', title: 'Call of Duty 30 Manual' },
            {
              identifier: id,
              title: 'Call of Duty 3 (USA)',
              collection: ['manuals', 'ps2-manuals']
            }
          ]
        }
      })
    if (parsed.pathname === `/metadata/${id}`)
      return Response.json({ files: [{ name: 'cod3_scandata.xml' }] })
    if (parsed.pathname.endsWith('_scandata.xml'))
      return new Response(
        '<book><pageData><page leafNum="0"><addToAccessFormats>true</addToAccessFormats></page><page leafNum="1"><addToAccessFormats>false</addToAccessFormats></page><page leafNum="2"></page><page leafNum="3"></page></pageData></book>'
      )
    if (/\/page\/n\d+.jpg$/.test(parsed.pathname)) return new Response(jpeg)
    throw Error(`Unexpected request: ${url}`)
  }

test('Wikipedia lead, developer/year and source are cached; offline reads never fetch', async () => {
  const paths = fixture()
  const calls = []
  const service = createGuideService({ ...paths, fetchImpl: fakeArchive(calls) })
  const lore = await service.getLore(game)
  assert.equal(lore.year, '2006')
  assert.equal(lore.developer, 'Treyarch')
  assert.equal(lore.summary.includes('extra paragraph'), false)
  assert.equal(lore.sourceUrl, 'https://en.wikipedia.org/wiki/Call_of_Duty_3')
  const offline = createGuideService({
    ...paths,
    fetchImpl: () => {
      throw Error('offline')
    }
  })
  assert.deepEqual(await offline.getLore(game), lore)
  assert.equal(calls.length, 1)
  const sparse = createGuideService({
    ...fixture(),
    fetchImpl: async () =>
      Response.json({
        ...summary,
        description: 'Video game',
        extract: 'Call of Duty 3 is a video game.'
      })
  })
  const missing = await sparse.getLore(game)
  assert.equal(missing.developer, null)
  assert.equal(missing.year, null)
})

test('ambiguous Wikipedia titles retry the video game title and unrelated articles stay empty', async () => {
  const calls = []
  const service = createGuideService({
    ...fixture(),
    fetchImpl: async (url) => {
      calls.push(url)
      return Response.json(
        url.includes('(video_game)')
          ? summary
          : { type: 'disambiguation', extract: 'Other meanings' }
      )
    }
  })
  assert(await service.getLore(game))
  assert.equal(calls.length, 2)
  const unrelated = createGuideService({
    ...fixture(),
    fetchImpl: async () => Response.json({ ...summary, title: 'Different Game' })
  })
  assert.equal(await unrelated.getLore(game), null)
})

test('manual search, visible leaves, lazy page cache, coalescing and offline page turning', async () => {
  const paths = fixture()
  const calls = []
  const service = createGuideService({ ...paths, fetchImpl: fakeArchive(calls) })
  const [manual, duplicate] = await Promise.all([service.getManual(game), service.getManual(game)])
  assert.deepEqual(manual, duplicate)
  assert.deepEqual(manual.leaves, [0, 2, 3])
  assert.equal(calls.length, 3)
  assert.match(new URL(calls[0]).searchParams.get('q'), /collection:\(videogamemanuals\)/)
  const [page, samePage] = await Promise.all([service.getPage(game, 1), service.getPage(game, 1)])
  assert.equal(page, samePage)
  assert(page.startsWith(path.join(paths.userData, 'media', game.gameId, 'manual')))
  assert.deepEqual(fs.readFileSync(page), jpeg)
  assert.equal(calls.length, 4)
  assert(calls.at(-1).endsWith('/page/n2.jpg'))
  const offline = createGuideService({
    ...paths,
    fetchImpl: async () => {
      throw Error('offline')
    }
  })
  assert.equal(await offline.getPage(game, 1), page)
  assert.equal(await offline.getPage(game, 0), null)
  assert.equal(await offline.getPage(game, 500), null)
  assert.equal(await offline.getPage(game, -1), null)
})

test('empty requested collection falls back to manuals collections with the same title', async () => {
  const calls = []
  const base = fakeArchive(calls)
  const service = createGuideService({
    ...fixture(),
    fetchImpl: (url) =>
      new URL(url).searchParams.get('q')?.includes('videogamemanuals')
        ? Response.json({ response: { docs: [] } })
        : base(url)
  })
  assert(await service.getManual(game))
  assert(new URL(calls[0]).searchParams.get('q').includes('collection:consolemanuals'))
})

test('feature flags disable network and cached results and can be configured again', async () => {
  const calls = []
  const service = createGuideService({
    ...fixture(),
    fetchImpl: fakeArchive(calls),
    features: { manualsEnabled: false, loreEnabled: false }
  })
  assert.equal(await service.getLore(game), null)
  assert.equal(await service.getManual(game), null)
  assert.equal(await service.getPage(game, 0), null)
  assert.equal(calls.length, 0)
  service.setFeatures({ loreEnabled: true })
  assert(await service.getLore(game))
  service.setFeatures({ loreEnabled: false })
  assert.equal(await service.getLore(game), null)
  assert.deepEqual(service.getFeatures(), { loreEnabled: false, manualsEnabled: false })
})

test('missing, malformed, restricted and offline responses resolve quietly to null', async () => {
  for (const response of [
    () => new Response('', { status: 404 }),
    () => new Response('bad json'),
    () => Response.json({ response: { docs: [] } }),
    () => {
      throw Error('offline')
    }
  ]) {
    const service = createGuideService({ ...fixture(), fetchImpl: async () => response() })
    assert.equal(await service.getLore(game), null)
    assert.equal(await service.getManual(game), null)
    assert.equal(await service.getPage(game, 0), null)
  }
  const base = fakeArchive()
  const privateManual = createGuideService({
    ...fixture(),
    fetchImpl: (url) =>
      url.includes('/metadata/')
        ? Response.json({ is_dark: true, files: [{ name: 'cod3_scandata.xml' }] })
        : base(url)
  })
  assert.equal(await privateManual.getManual(game), null)
})

test('timeouts cover both headers and body; invalid/oversized image responses are never cached', async () => {
  for (const scenario of ['timeout', 'body-timeout', 'html', 'size']) {
    const paths = fixture()
    const base = fakeArchive()
    const service = createGuideService({
      ...paths,
      timeoutMs: 25,
      fetchImpl: async (url, { signal }) => {
        if (!url.includes('/page/n')) return base(url)
        if (scenario === 'timeout')
          return new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(Error('timeout')), { once: true })
          )
        if (scenario === 'body-timeout')
          return new Response(
            new ReadableStream({
              start(c) {
                signal.addEventListener('abort', () => c.error(Error('timeout')), { once: true })
              }
            })
          )
        if (scenario === 'size')
          return new Response(jpeg, { headers: { 'content-length': String(9 * 1024 * 1024) } })
        return new Response('<html>not an image</html>')
      }
    })
    assert.equal(await service.getPage(game, 0), null)
    const files = fs.readdirSync(path.join(paths.userData, 'media', game.gameId, 'manual'))
    assert.deepEqual(files, ['index.json'])
  }
})

test('Archive ia/dn storage mirrors serve scan metadata and pages; hint guides are excluded', async () => {
  const calls = []
  const base = fakeArchive(calls)
  const service = createGuideService({
    ...fixture(),
    fetchImpl: (url) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/advancedsearch.php')
        return Response.json({
          response: {
            docs: [
              { identifier: 'ps2_hint_guide', title: 'Call of Duty 3 [mini hint guide] (USA)' },
              { identifier: id, title: 'Call of Duty 3 (USA)' }
            ]
          }
        })
      if (parsed.pathname.includes('/download/'))
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://dn720004.ca.archive.org/0/items/${id}/${parsed.pathname.split('/').at(-1)}`
          }
        })
      if (parsed.hostname.startsWith('dn'))
        return parsed.pathname.endsWith('.xml')
          ? new Response('<book><page leafNum="0"></page></book>')
          : new Response(jpeg)
      return base(url)
    }
  })
  assert(await service.getPage(game, 0))
  assert(!calls.some((url) => url.includes('ps2_hint_guide')))
})

test('invalid game paths and external image redirects are rejected', async () => {
  const calls = []
  const base = fakeArchive(calls)
  const service = createGuideService({
    ...fixture(),
    fetchImpl: (url) =>
      url.includes('/page/n')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://evil.example/page.jpg' }
          })
        : base(url)
  })
  assert.equal(await service.getLore({ ...game, gameId: '../outside' }), null)
  assert.equal(await service.getManual({ ...game, gameId: '../outside' }), null)
  assert.equal(calls.length, 0)
  assert.equal(await service.getPage(game, 0), null)
  assert(!calls.some((url) => url.includes('evil.example')))
})
