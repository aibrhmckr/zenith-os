import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import {
  createSnapshot,
  createBatchedWriter,
  createWorkQueue,
  createProgressPublisher,
  mapCooperatively
} from '../src/main/services/workScheduling.js'
import {
  extractCoreAsync,
  createCoreManager,
  CORE_UPDATE_INTERVAL_MS
} from '../src/main/services/coreManager.js'
import { libraryWindow } from '../src/renderer/src/hooks/libraryWindow.js'
import { createGuideService } from '../src/main/services/guideService.js'
import { createFileBrowser } from '../src/main/services/fileBrowser.js'
import { seedBundledRetroArch } from '../src/main/services/bundledRuntime.js'
import { createMediaDownloader } from '../src/main/services/mediaScraper.js'
import { coreArchive, coreBinary } from './fixtures/core-archive.cjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-perf-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return root
}

test('library snapshots coalesce readers, explicit refresh and mutation invalidate cached results', async () => {
  let calls = 0
  const cache = createSnapshot(async () => {
    await tick()
    return ++calls
  })
  assert.deepEqual(await Promise.all([cache.get(), cache.get(), cache.get()]), [1, 1, 1])
  assert.equal(await cache.get(), 1)
  assert.equal(await cache.get({ fresh: true }), 2)
  cache.invalidate()
  assert.equal(await cache.get(), 3)
})

test('cooperative metadata batches yield before and during a large library traversal', async () => {
  let turns = 0,
    active = true
  const poll = async () => {
    while (active) {
      await tick()
      turns++
    }
  }
  const heartbeat = poll()
  const items = Array.from({ length: 1000 }, (_, i) => i)
  assert.deepEqual(
    await mapCooperatively(items, (x) => x * 2),
    items.map((x) => x * 2)
  )
  active = false
  await heartbeat
  assert(turns >= 100, 'Main event loop must receive time between bounded batches')
})

test('invalidation during a scan makes all readers observe the replacement snapshot', async () => {
  let release,
    calls = 0
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const snapshot = createSnapshot(async () => {
    const value = ++calls
    if (value === 1) await gate
    return value
  })
  const first = snapshot.get()
  await tick()
  snapshot.invalidate()
  const second = snapshot.get()
  release()
  assert.deepEqual(await Promise.all([first, second]), [2, 2])
  assert.equal(calls, 2)
})

test('concurrent persistence flushes drain later work even when the active write fails', async () => {
  let release,
    calls = 0
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const writer = createBatchedWriter(async () => {
    if (++calls === 1) {
      await gate
      throw Error('disk full')
    }
  }, 1)
  const rejected = assert.rejects(writer.request(), /disk full/)
  const firstFlush = writer.flush()
  await tick()
  const next = writer.request()
  const secondFlush = writer.flush()
  release()
  await Promise.all([rejected, firstFlush, next, secondFlush])
  assert.equal(calls, 2)
})

test('batched persistence collapses a burst and recovers after a failed write', async () => {
  let writes = 0,
    fail = false
  const writer = createBatchedWriter(async () => {
    writes++
    if (fail) throw Error('disk full')
  })
  const pending = Array.from({ length: 100 }, () => writer.request())
  await writer.flush()
  await Promise.all(pending)
  assert.equal(writes, 1)
  fail = true
  const failed = assert.rejects(writer.request(), /disk full/)
  await writer.flush()
  await failed
  fail = false
  const retry = writer.request()
  await writer.flush()
  await retry
  assert.equal(writes, 3)
})

test('optional jobs stop while paused, resume without duplication, and respect concurrency', async () => {
  const queue = createWorkQueue(2)
  queue.setPaused(true)
  let active = 0,
    peak = 0,
    completed = 0
  const jobs = Array.from({ length: 10 }, () =>
    queue.schedule(async () => {
      active++
      peak = Math.max(peak, active)
      await tick()
      active--
      completed++
    })
  )
  await tick()
  assert.equal(completed, 0)
  queue.setPaused(false)
  await Promise.all(jobs)
  await queue.whenIdle()
  assert.equal(completed, 10)
  assert.equal(peak, 2)
})

test('IPC progress batches retain every game and only the newest counters', () => {
  const events = [],
    publisher = createProgressPublisher((value) => events.push(value))
  for (let i = 0; i < 1000; i++)
    publisher.report({ completed: i + 1, total: 1000, game: { id: i } })
  publisher.flush()
  assert.equal(events.length, 1)
  assert.equal(events[0].games.length, 1000)
  assert.equal(events[0].completed, 1000)
})

test('windowed grid bounds DOM work, retains global focus and supports distant mouse scrolling', () => {
  for (const columns of [1, 4, 8, 12]) {
    const indices = libraryWindow(5000, columns, 2499, 400)
    assert(indices.includes(2499))
    assert(indices.includes(400 * columns))
    assert(indices.length <= columns * 14)
    assert.equal(new Set(indices).size, indices.length)
  }
  assert.equal(libraryWindow(75, 8, 74).length, 75)
})

test('core worker verifies bytes and corruption without blocking the caller', async () => {
  const name = 'example_libretro.dll',
    data = Buffer.alloc(4 * 1024 * 1024)
  coreBinary(name).copy(data)
  const archive = coreArchive(name, data)
  let yielded = false
  const pending = extractCoreAsync(archive, name, 'win32')
  await tick()
  yielded = true
  assert.deepEqual(await pending, data)
  assert(yielded)
  await assert.rejects(extractCoreAsync(Buffer.from('invalid zip'), name, 'win32'))
})

test('unchanged remote core revalidates its receipt without download jobs or binary replacement', async (t) => {
  const root = await fixture(t),
    name = 'mupen64plus_next_libretro.dll'
  let clock = Date.now(),
    calls = 0
  const events = []
  const manager = createCoreManager({
    retroarchDir: root,
    platform: 'win32',
    arch: 'x64',
    now: () => clock,
    onProgress: (value) => events.push(value),
    fetchImpl: async (_url, options) => {
      calls++
      if (calls === 1)
        return new Response(coreArchive(name), { headers: { etag: '"version-one"' } })
      assert.equal(options.headers['If-None-Match'], '"version-one"')
      return new Response(null, { status: 304 })
    }
  })
  assert.equal((await manager.install('N64')).success, true)
  const file = path.join(root, 'cores', name),
    before = await fs.stat(file)
  events.length = 0
  clock += CORE_UPDATE_INTERVAL_MS + 1
  assert.equal((await manager.installNamed(name, true)).upToDate, true)
  assert.equal(events.length, 0)
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs)
})

test('missing manuals are cached across service instances without caching network failures', async (t) => {
  const root = await fixture(t),
    game = { gameId: 'example', title: 'Example', systemShort: 'NDS' }
  let calls = 0
  const options = {
    userData: root,
    fetchImpl: async () => {
      calls++
      return Response.json({ response: { docs: [] } })
    }
  }
  assert.equal(await createGuideService(options).getManual(game), null)
  assert.equal(calls, 2)
  assert.equal(await createGuideService(options).getManual(game), null)
  assert.equal(calls, 2)
})

test('optional provider discovery has an overall deadline and releases the worker after timeout', async (t) => {
  const root = await fixture(t)
  let calls = 0
  const run = createMediaDownloader({
    userData: root,
    jobTimeoutMs: 30,
    timeoutMs: 1000,
    fetchImpl: (_url, { signal }) =>
      new Promise((resolve, reject) => {
        calls++
        const timer = setTimeout(() => resolve(Response.json({ response: { docs: [] } })), 500)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(signal.reason)
          },
          { once: true }
        )
      })
  })
  const started = performance.now()
  const result = await run(
    { gameId: 'example', title: 'Example', systemShort: 'NDS' },
    { kinds: ['music'] }
  )
  assert.equal(result.music, null)
  assert.equal(calls, 1)
  assert(performance.now() - started < 450, 'Overall budget stops provider fallback chains')
})

test('file-browser pagination reuses sorting but revalidates each returned file', async (t) => {
  const root = await fixture(t)
  await Promise.all(
    Array.from({ length: 260 }, (_, i) => fs.writeFile(path.join(root, `${i}.nds`), 'rom'))
  )
  const readdir = fs.readdir
  let listings = 0
  t.mock.method(fs, 'readdir', (...args) => {
    listings++
    return readdir(...args)
  })
  const browser = createFileBrowser({ home: root, roots: [root] })
  await browser.list({ kind: 'games', path: root })
  const page = await browser.list({ kind: 'games', path: root, offset: 250 })
  assert.equal(listings, 1)
  assert.equal(page.entries.length, 10)
  await fs.writeFile(path.join(root, page.entries[0].name), 'changed')
  await assert.rejects(browser.consume('games', [page.entries[0].token]), /changed/)
})

test('runtime seed receipt skips autoconfig traversal but repairs a missing critical binary', async (t) => {
  const root = await fixture(t),
    source = path.join(root, 'resources', 'emulators', 'retroarch'),
    target = path.join(root, 'runtime')
  await fs.mkdir(path.join(source, 'autoconfig'), { recursive: true })
  for (const file of ['retroarch.exe', 'support.dll', 'autoconfig/pad.cfg'])
    await fs.writeFile(path.join(source, file), 'fixture')
  let walks = 0
  const fsImpl = {
    ...fs,
    readdir: (...args) => {
      walks++
      return fs.readdir(...args)
    }
  }
  const options = {
    resourcesPath: path.join(root, 'resources'),
    retroarchDir: target,
    platform: 'win32',
    fsImpl
  }
  await seedBundledRetroArch(options)
  walks = 0
  await seedBundledRetroArch(options)
  assert.equal(walks, 0)
  await fs.unlink(path.join(target, 'support.dll'))
  await seedBundledRetroArch(options)
  assert(walks > 0)
  assert.equal(await fs.readFile(path.join(target, 'support.dll'), 'utf8'), 'fixture')
})
