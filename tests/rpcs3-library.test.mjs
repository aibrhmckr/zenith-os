import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { readParamSfo, scanRpcs3Games } from '../src/main/services/rpcs3Library.js'
import { createRpcs3Runtime } from '../src/main/services/rpcs3Runtime.js'
import { createScraper, gameMediaId } from '../src/main/services/scraper.js'
import { createLibraryStore } from '../src/main/services/libraryStore.js'
const { paramSfo } = createRequire(import.meta.url)('./fixtures/ps3-sfo.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-ps3-library-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtime = createRpcs3Runtime({ userData: root, platform: 'win32' })
  runtime.ensureDirectories()
  const titles = path.join(runtime.dataDirectory('dev_hdd0'), 'game')
  const add = (id, title, category = 'HG') => {
    const dir = path.join(titles, id)
    fs.mkdirSync(path.join(dir, 'USRDIR'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'USRDIR/EBOOT.BIN'), 'synthetic boot')
    fs.writeFileSync(
      path.join(dir, 'PARAM.SFO'),
      paramSfo({ TITLE_ID: id, TITLE: title, CATEGORY: category })
    )
    return dir
  }
  return { root, runtime, titles, add }
}

test('bounded SFO parser preserves UTF-8 titles and rejects truncated/malformed tables', () => {
  const bytes = paramSfo({ TITLE: 'Özel Oyun 日本', TITLE_ID: 'NPUB12345', CATEGORY: 'HG' })
  assert.equal(readParamSfo(bytes).TITLE, 'Özel Oyun 日本')
  for (const bad of [
    bytes.subarray(0, 4),
    bytes.subarray(0, bytes.length - 1),
    Buffer.alloc(1024 * 1024 + 1)
  ])
    assert.throws(() => readParamSfo(bad))
  const offset = Buffer.from(bytes)
  offset.writeUInt32LE(0xffffffff, 32)
  assert.throws(() => readParamSfo(offset))
  const duplicate = Buffer.from(bytes)
  duplicate.writeUInt16LE(0, 36)
  assert.throws(() => readParamSfo(duplicate), /Duplicate/)
})

test('installed library reads distinct titles, stable IDs and media metadata on repeated scans', async (t) => {
  const f = fixture(t)
  f.add('NPUB12345', 'Özel Oyun (Demo)')
  f.add('NPEB12345', 'Özel Oyun (Demo)')
  const games = scanRpcs3Games(f.runtime)
  assert.equal(games.length, 2)
  assert(
    games.every(
      (g) =>
        g.systemShort === 'PS3' &&
        path.isAbsolute(g.path) &&
        g.path.endsWith(path.join('USRDIR', 'EBOOT.BIN'))
    )
  )
  assert.equal(new Set(games.map(gameMediaId)).size, 2)
  assert.deepEqual(scanRpcs3Games(f.runtime), games)
  const scraper = createScraper({
    userData: f.root,
    fetchImpl: async () => new Response('', { status: 404 })
  })
  assert.equal(scraper.enrich(games[0]).title, 'Özel Oyun (Demo)')
  const result = await scraper.scan(games, () => {}, {})
  assert.equal(result.games.length, 2)
  const before = gameMediaId(games[0])
  const updated = { ...games[0], title: 'New title' }
  assert.equal(gameMediaId(updated), before)
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, 'games.json'), 'utf8'))
  assert(JSON.stringify(manifest).includes('Özel Oyun (Demo)'))
  const store = createLibraryStore(f.root)
  store.add([games[0].path])
  store.remove(games[0].path)
  assert(store.excluded(games[0].path))
  store.add([games[0].path])
  assert(!store.excluded(games[0].path))
})

test('incomplete installs, data-only updates, mismatched IDs and malformed titles are skipped', (t) => {
  const f = fixture(t)
  const valid = f.add('NPUB00001', 'Playable')
  fs.unlinkSync(path.join(f.add('NPUB00002', 'Missing boot'), 'USRDIR/EBOOT.BIN'))
  fs.writeFileSync(path.join(f.add('NPUB00003', 'Empty boot'), 'USRDIR/EBOOT.BIN'), '')
  fs.writeFileSync(path.join(f.add('NPUB00004', 'Broken SFO'), 'PARAM.SFO'), 'bad')
  f.add('NPUB00005', 'Game update', 'GD')
  fs.writeFileSync(
    path.join(f.add('NPUB00006', 'Wrong ID'), 'PARAM.SFO'),
    paramSfo({ TITLE_ID: 'NPUB99999', TITLE: 'Wrong', CATEGORY: 'HG' })
  )
  assert.deepEqual(
    scanRpcs3Games(f.runtime).map((g) => g.title),
    ['Playable']
  )
  fs.unlinkSync(path.join(valid, 'PARAM.SFO'))
  assert.deepEqual(scanRpcs3Games(f.runtime), [])
})

test('scanner honors owned VFS paths and skips junctions or external mappings', (t) => {
  const f = fixture(t)
  f.add('NPUB00001', 'Original')
  const custom = path.join(f.runtime.directory, 'custom-hdd')
  fs.renameSync(path.dirname(f.titles), custom)
  fs.mkdirSync(path.join(f.runtime.configDirectory, 'config'), { recursive: true })
  const vfs = path.join(f.runtime.configDirectory, 'config/vfs.yml')
  fs.writeFileSync(vfs, JSON.stringify({ '/dev_hdd0/': custom }))
  assert.equal(scanRpcs3Games(f.runtime).length, 1)
  fs.symlinkSync(
    path.join(custom, 'game/NPUB00001'),
    path.join(custom, 'game/NPUB00002'),
    'junction'
  )
  assert.equal(scanRpcs3Games(f.runtime).length, 1)
  fs.writeFileSync(vfs, JSON.stringify({ '/dev_hdd0/': f.root }))
  assert.deepEqual(scanRpcs3Games(f.runtime), [])
})
