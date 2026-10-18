import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createFileBrowser } from '../src/main/services/fileBrowser.js'
import { serveMedia } from '../src/main/services/local-media.js'
import { createFolderSummary } from '../src/main/services/folderSummary.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-browser-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const browser = createFileBrowser({ home: root, roots: [root] })
  return { root, browser }
}

test('browser lists local roots, directories first, and purpose-specific case-insensitive files', async (t) => {
  const { root, browser } = await fixture(t)
  await fs.mkdir(path.join(root, 'Folder'))
  for (const name of ['Game.ISO', 'Game.pkg', 'Art.PNG', 'Loop.mp4', 'PS3UPDAT.PuP', 'hidden.exe'])
    await fs.writeFile(path.join(root, name), 'fixture')
  assert.equal((await browser.list({ kind: 'games' })).entries.length, 1)
  const games = await browser.list({ kind: 'games', path: root })
  assert.deepEqual(
    games.entries.map((e) => e.name),
    ['Folder', 'Game.ISO', 'Game.pkg']
  )
  const art = await browser.list({ kind: 'wallpaper', path: root })
  assert.deepEqual(
    art.entries.map((e) => e.name),
    ['Folder', 'Art.PNG', 'Loop.mp4']
  )
  assert.equal(games.parent, null)
  assert.equal(games.breadcrumbs.at(-1).path, root)
  assert.equal(games.entries[1].size, 7)
  assert.equal(typeof games.entries[1].modified, 'number')
  assert.equal(games.entries[1].platform, null, 'Uninspected ISO must not pretend to be PS2')
  const packages = await browser.list({ kind: 'package', path: root })
  const firmware = await browser.list({ kind: 'firmware', path: root })
  assert.deepEqual(
    firmware.entries.map((e) => e.name),
    ['Folder', 'PS3UPDAT.PuP']
  )
  await assert.rejects(browser.consume('firmware', [packages.entries[1].token]), /expired/)
  await assert.rejects(browser.consume('package', [firmware.entries[1].token]), /expired/)
  assert.deepEqual(await browser.consume('firmware', [firmware.entries[1].token]), [
    path.join(root, 'PS3UPDAT.PuP')
  ])
  await assert.rejects(browser.consume('firmware', [firmware.entries[1].token]), /expired/)
  assert.deepEqual(
    packages.entries.map((e) => e.name),
    ['Folder', 'Game.pkg']
  )
  await assert.rejects(browser.consume('games', [packages.entries[1].token]), /expired/)
  assert.deepEqual(await browser.consume('package', [packages.entries[1].token]), [
    path.join(root, 'Game.pkg')
  ])
  const token = games.entries[1].token
  await assert.rejects(browser.consume('wallpaper', [token]), /expired/)
  assert.deepEqual(await browser.consume('games', [token]), [path.join(root, 'Game.ISO')])
  await assert.rejects(browser.consume('games', [token]), /expired/)
  await assert.rejects(browser.consume('games', [path.join(root, 'Game.ISO')]), /expired/)
})

test('quick access uses supplied system paths and preview URLs are validated and revocable', async (t) => {
  const { root } = await fixture(t)
  const desktop = path.join(root, 'Desktop'),
    downloads = path.join(root, 'Downloads')
  await fs.mkdir(desktop)
  await fs.mkdir(downloads)
  const browser = createFileBrowser({ home: root, desktop, downloads, roots: [root] })
  assert.deepEqual(
    (await browser.list({ kind: 'wallpaper' })).entries.map((e) => e.shortcut),
    ['home', 'desktop', 'downloads']
  )
  const png = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex')
  await fs.writeFile(path.join(root, 'Art.png'), png)
  await fs.writeFile(path.join(root, 'Bad.png'), 'not an image')
  const entries = (await browser.list({ kind: 'wallpaper', path: root })).entries
  const token = entries.find((e) => e.name === 'Art.png').token
  const first = await browser.preview(token)
  assert.match(first.url, /^game-media:/)
  assert.equal(serveMedia(new Request(first.url)).status, 200)
  const second = await browser.preview(token)
  assert.notEqual(second.url, first.url)
  assert.equal(serveMedia(new Request(first.url)).status, 404)
  await browser.preview(null)
  assert.equal(serveMedia(new Request(second.url)).status, 404)
  await assert.rejects(browser.preview(entries.find((e) => e.name === 'Bad.png').token), /format/)
  await assert.rejects(browser.preview(path.join(root, 'Art.png')), /expired/)
  assert.deepEqual(
    await browser.consume('wallpaper', [token]),
    [path.join(root, 'Art.png')],
    'Preview does not consume import authority'
  )
})

test('browser rejects changed files, invalid purposes, invalid pages and nonlocal paths', async (t) => {
  const { root, browser } = await fixture(t)
  const file = path.join(root, 'Game.iso')
  await fs.writeFile(file, 'fixture')
  const token = (await browser.list({ kind: 'games', path: root })).entries[0].token
  await fs.appendFile(file, 'changed')
  await assert.rejects(browser.consume('games', [token]), /changed/)
  await assert.rejects(browser.consume('games', [token, token]), /Select files/)
  await assert.rejects(browser.list({ kind: 'unknown' }), /purpose/)
  await assert.rejects(browser.list({ kind: 'games', offset: -1 }), /page/)
  await assert.rejects(browser.list({ kind: 'games', path: '../relative' }), /local directory/)
  if (process.platform === 'win32') {
    for (const path of ['\\\\server\\share', 'C:\\games:stream', '\\\\?\\C:\\games'])
      await assert.rejects(browser.list({ kind: 'games', path }), /local directory/)
  }
})

test('large directories paginate without losing entries or loading unsupported files', async (t) => {
  const { root, browser } = await fixture(t)
  await Promise.all(
    Array.from({ length: 251 }, (_, i) => fs.writeFile(path.join(root, `Game${i}.gba`), 'rom'))
  )
  const first = await browser.list({ kind: 'games', path: root })
  const second = await browser.list({ kind: 'games', path: root, offset: first.nextOffset })
  assert.equal(first.entries.length, 250)
  assert.equal(second.entries.length, 1)
  assert.equal(second.nextOffset, null)
  assert.equal(new Set([...first.entries, ...second.entries].map((e) => e.name)).size, 251)
})

test('folder summaries include nested and filtered-out files, with physical size/date metadata', async (t) => {
  const { root, browser } = await fixture(t)
  const directory = path.join(root, 'Documents')
  await fs.mkdir(path.join(directory, 'Nested'), { recursive: true })
  await fs.writeFile(path.join(directory, 'image.png'), Buffer.alloc(1024))
  await fs.writeFile(path.join(directory, 'Nested', 'notes.txt'), Buffer.alloc(2048))
  await fs.utimes(path.join(directory, 'image.png'), new Date('2020-01-02'), new Date('2020-01-02'))
  const entry = (await browser.list({ kind: 'wallpaper', path: root })).entries[0]
  assert.equal(entry.name, 'Documents')
  assert.equal(typeof entry.modified, 'number')
  const summary = await browser.folderSummary(entry.summaryToken)
  assert.deepEqual(summary, { files: 2, folders: 1, size: 3072, skipped: 0, partial: false })
  const file = (await browser.list({ kind: 'wallpaper', path: directory })).entries.find(
    (e) => e.name === 'image.png'
  )
  assert.equal(file.size, 1024)
  assert.equal(file.modified, Date.parse('2020-01-02'))
  await assert.rejects(browser.folderSummary(directory), /expired/)
  await assert.rejects(browser.folderSummary(file.token), /expired/)
  assert.deepEqual(await browser.folderSummary(null), { canceled: true })
})

test('summary limits, cancellation and symlinks never masquerade as complete totals', async (t) => {
  const { root } = await fixture(t)
  await fs.writeFile(path.join(root, 'one.txt'), 'one')
  await fs.writeFile(path.join(root, 'two.txt'), 'two')
  const summary = createFolderSummary({ maxEntries: 1 })
  assert.equal((await summary.scan(root)).partial, true)
  const limited = createFolderSummary({ timeBudgetMs: 0 })
  assert.equal((await limited.scan(root)).partial, true)
  const pending = summary.scan(root)
  summary.cancel()
  assert.deepEqual(await pending, { canceled: true })
  await fs.symlink(
    root,
    path.join(root, 'Cycle'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const safe = await createFolderSummary().scan(root)
  assert.deepEqual(safe, { files: 2, folders: 0, size: 6, skipped: 1, partial: true })
})
