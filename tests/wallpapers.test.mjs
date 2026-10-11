import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import {
  createWallpaperManager,
  validWallpaperHeader,
  MAX_WALLPAPER_BYTES
} from '../src/main/services/wallpapers.js'
import { createPreferences } from '../src/main/services/preferences.js'
import { serveMedia } from '../src/main/services/local-media.js'
import { wallpaperGameMedia } from '../src/shared/wallpapers.js'
import { createCursorVisibility } from '../src/renderer/src/hooks/cursorVisibility.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=',
  'base64'
)
async function fixture(t) {
  const root = await fs.mkdtemp(join(os.tmpdir(), 'zenith-wallpapers-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const userData = join(root, 'profile'),
    preferences = createPreferences(userData)
  return { root, userData, preferences, manager: createWallpaperManager({ userData, preferences }) }
}

test('wallpaper defaults, imported copies, opaque URLs and preferences persist across restart', async (t) => {
  const { root, userData, preferences, manager } = await fixture(t)
  assert.equal((await manager.list()).items.length, 5)
  assert.equal((await manager.list()).selectedId, 'minimal-dark')
  assert.equal((await manager.list()).onlyCustom, false)
  const source = join(root, 'Wallpaper.PNG')
  await fs.writeFile(source, png)
  const added = await manager.importFile(source),
    item = added.items.at(-1)
  assert.equal(item.type, 'image')
  assert(item.url.startsWith('game-media://local/'))
  assert(!JSON.stringify(item).includes(userData))
  await fs.unlink(source)
  assert.deepEqual(await fs.readFile(join(userData, 'wallpapers', item.id)), png)
  await manager.update({ selectedId: item.id, onlyCustom: true })
  const restored = createWallpaperManager({ userData, preferences: createPreferences(userData) })
  assert.equal((await restored.list()).selectedId, item.id)
  assert.equal((await restored.list()).onlyCustom, true)
  const response = serveMedia(new Request(item.url))
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
  await preferences.update({ hotkeys: { example: true } })
  assert.equal((await manager.list()).onlyCustom, true)
  await fs.unlink(join(userData, 'wallpapers', item.id))
  assert.equal((await manager.list()).selectedId, 'minimal-dark')
})

test('wallpaper imports reject unsupported, forged, oversized files and unregistered selections', async (t) => {
  const { root, userData, manager } = await fixture(t)
  for (const name of ['bad.png', 'bad.exe']) {
    const file = join(root, name)
    await fs.writeFile(file, 'not media')
    await assert.rejects(manager.importFile(file), /wallpaper/)
  }
  const huge = join(root, 'large.mp4')
  await fs.writeFile(huge, '')
  await fs.truncate(huge, MAX_WALLPAPER_BYTES + 1)
  await assert.rejects(manager.importFile(huge), /200 MB/)
  await assert.rejects(manager.update({ selectedId: '../../outside.png' }), /unavailable/)
  await assert.rejects(manager.update({ onlyCustom: 'true' }), /Invalid/)
  await assert.rejects(manager.update({ path: '/outside.png' }), /Invalid/)
  assert.deepEqual(await fs.readdir(join(userData, 'wallpapers')), [])
})

test('video and WebP wallpaper formats use registered streaming MIME types', async (t) => {
  const { root, manager } = await fixture(t)
  const samples = {
    mp4: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]),
    webm: Buffer.from([26, 69, 223, 163, 0, 0, 0, 0]),
    webp: Buffer.from('RIFF0000WEBPVP8 synthetic'),
    jpg: Buffer.from([255, 216, 255, 224, 0, 0])
  }
  for (const [extension, bytes] of Object.entries(samples)) {
    assert(validWallpaperHeader(bytes, '.' + extension))
    const file = join(root, 'custom.' + extension)
    await fs.writeFile(file, bytes)
    const item = (await manager.importFile(file)).items.at(-1)
    assert.equal(item.type, ['mp4', 'webm'].includes(extension) ? 'video' : 'image')
    const response = serveMedia(new Request(item.url, { headers: { range: 'bytes=0-3' } }))
    assert.equal(response.status, 206)
    assert.equal(
      response.headers.get('content-type'),
      { mp4: 'video/mp4', webm: 'video/webm', webp: 'image/webp', jpg: 'image/jpeg' }[extension]
    )
    await response.arrayBuffer()
  }
})

test('wallpaper priority suppresses game backgrounds only in override mode and tolerates failed assets', () => {
  const game = { backdropUrl: 'image', videoUrl: 'video' }
  assert.deepEqual(wallpaperGameMedia(game, false), { image: 'image', video: 'video' })
  assert.deepEqual(wallpaperGameMedia(game, true), { image: null, video: null })
  assert.deepEqual(wallpaperGameMedia(null, false), { image: null, video: null })
  assert.deepEqual(wallpaperGameMedia(game, false, { image: 'image', video: 'video' }), {
    image: null,
    video: null
  })
})

test('single and bulk deletion revoke media, persist fallback, preserve built-ins and external files', async (t) => {
  const { root, userData, manager } = await fixture(t)
  const source = join(root, 'keep.png')
  await fs.writeFile(source, png)
  const first = (await manager.importFile(source)).items.at(-1)
  const second = (await manager.importFile(source)).items.at(-1)
  await manager.update({ selectedId: first.id })
  await assert.rejects(manager.remove({ id: first.id }), /confirmation/)
  await assert.rejects(manager.remove({ all: true }), /confirmation/)
  await assert.rejects(manager.remove({ id: '../../keep.png', confirmed: true }), /Unknown/)
  await assert.rejects(manager.remove({ id: 'minimal-dark', confirmed: true }), /Unknown/)
  let result = await manager.remove({ id: first.id, confirmed: true })
  assert.equal(result.selectedId, 'minimal-dark')
  assert.equal(result.items.length, 6)
  await assert.rejects(fs.stat(join(userData, 'wallpapers', first.id)), { code: 'ENOENT' })
  assert.equal(serveMedia(new Request(first.url)).status, 404)
  assert.deepEqual(await fs.readFile(source), png)
  await manager.update({ selectedId: second.id })
  result = await manager.remove({ all: true, confirmed: true })
  assert.equal(result.selectedId, 'minimal-dark')
  assert.equal(result.items.length, 5)
  assert(result.items.some((item) => item.id === 'luminescent-glade'))
  assert.deepEqual(await fs.readdir(join(userData, 'wallpapers')), [])
  const restarted = createWallpaperManager({ userData, preferences: createPreferences(userData) })
  assert.equal((await restarted.list()).selectedId, 'minimal-dark')
  assert.equal((await restarted.list()).items.length, 5)
})

test('cursor is hidden on gamepad activity and idle; movement resets timeout and disposal cancels it', () => {
  let hidden,
    time = 0,
    nextId = 0
  const timers = new Map()
  const advance = (ms) => {
    time += ms
    for (const [id, entry] of timers)
      if (entry.at <= time) {
        timers.delete(id)
        entry.fn()
      }
  }
  const cursor = createCursorVisibility({
    setHidden: (value) => {
      hidden = value
    },
    schedule: (fn, ms) => {
      const id = ++nextId
      timers.set(id, { fn, at: time + ms })
      return id
    },
    cancel: (id) => timers.delete(id)
  })
  assert.equal(hidden, false)
  advance(1999)
  assert.equal(hidden, false)
  cursor.move()
  advance(1)
  assert.equal(hidden, false)
  advance(1999)
  assert.equal(hidden, true)
  cursor.move()
  cursor.gamepad()
  assert.equal(hidden, true)
  assert.equal(timers.size, 0)
  cursor.move()
  assert.equal(hidden, false)
  cursor.dispose()
  assert.equal(timers.size, 0)
})

test('multi-selection validates all IDs first and removes only selected copies, preserving an unselected active wallpaper', async (t) => {
  const { root, userData, manager } = await fixture(t)
  const source = join(root, 'multi.png')
  await fs.writeFile(source, png)
  const first = (await manager.importFile(source)).items.at(-1)
  const keep = (await manager.importFile(source)).items.at(-1)
  const third = (await manager.importFile(source)).items.at(-1)
  await manager.update({ selectedId: keep.id })
  for (const ids of [
    [],
    [first.id, '../../outside.png'],
    [first.id, 'minimal-dark'],
    [null],
    'invalid',
    [first.id, '00000000-0000-0000-0000-000000000000.png']
  ]) {
    await assert.rejects(manager.remove({ ids, confirmed: true }))
    assert.deepEqual(await fs.readFile(join(userData, 'wallpapers', first.id)), png)
  }
  await assert.rejects(manager.remove({ ids: [first.id, third.id], confirmed: false }))
  const result = await manager.remove({ ids: [first.id, third.id, first.id], confirmed: true })
  assert.equal(result.selectedId, keep.id)
  assert.deepEqual(
    result.items.filter((item) => item.type !== 'theme').map((item) => item.id),
    [keep.id]
  )
  assert.deepEqual(await fs.readdir(join(userData, 'wallpapers')), [keep.id])
  assert.deepEqual(await fs.readFile(source), png)
  assert.equal(
    (await manager.remove({ ids: [keep.id], confirmed: true })).selectedId,
    'minimal-dark'
  )
})
