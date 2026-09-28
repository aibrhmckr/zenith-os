import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createGameImporter } from '../src/main/services/gameImporter.js'
import { normalizeHotkeys, createGamepadHotkey, windowsKeyCode } from '../src/shared/hotkeys.js'
import { createLibraryStore } from '../src/main/services/libraryStore.js'
import { gameMediaId } from '../src/main/services/scraper.js'
import { GAME_FILE_FILTERS } from '../src/shared/consoles.js'
const temp = (t) => {
  const p = fs.mkdtempSync(join(os.tmpdir(), 'zenith-import-'))
  t.after(() => fs.rmSync(p, { recursive: true, force: true }))
  return p
}
test('central imports preserve originals, handle collisions and publish complete copies', async (t) => {
  const root = temp(t),
    games = join(root, 'games'),
    source = join(root, 'PSP', 'Example.iso')
  fs.mkdirSync(join(root, 'PSP'))
  fs.writeFileSync(source, 'fixture')
  const importer = createGameImporter(games)
  const [a, b] = await Promise.all([importer([source]), importer([source])])
  assert.equal(a[0], join(games, 'Example (PSP).iso'))
  assert.notEqual(a[0], b[0])
  assert.equal(fs.readFileSync(a[0], 'utf8'), 'fixture')
  fs.unlinkSync(source)
  assert.equal(fs.readFileSync(b[0], 'utf8'), 'fixture')
  assert.deepEqual(await importer(a), a)
  assert(!fs.readdirSync(games).some((name) => name.endsWith('.part')))
  await assert.rejects(importer([source]))
  assert.equal(fs.readdirSync(games).length, 2)
})
test('hotkey validation accepts only supported distinct pairs and safe native keys', () => {
  assert.deepEqual(normalizeHotkeys(null), { gamepad: [8, 9], keyboard: [] })
  assert.deepEqual(normalizeHotkeys({ gamepad: [4, 5], keyboard: ['KeyQ', 'KeyE'] }), {
    gamepad: [4, 5],
    keyboard: ['KeyQ', 'KeyE']
  })
  for (const value of [
    { gamepad: [1, 2] },
    { gamepad: [17, 2] },
    { gamepad: [2, 2] },
    { keyboard: ['KeyQ', 'KeyQ'] },
    { keyboard: ['Escape', 'F10'] },
    { keyboard: [';cmd', 'KeyQ'] }
  ])
    assert.deepEqual(normalizeHotkeys(value), { gamepad: [8, 9], keyboard: [] })
  assert.equal(windowsKeyCode('KeyQ'), 81)
  assert.equal(windowsKeyCode('KeyE'), 69)
  assert.equal(windowsKeyCode('F10'), 121)
})
test('chords fire once and never leak constituent standalone actions', () => {
  const sample = createGamepadHotkey()
  let old = []
  const frame = (pressed) => {
    const buttons = Array.from({ length: 17 }, (_, i) => pressed.includes(i))
    const previous = old
    old = buttons
    return {
      buttons,
      hit: (i) => buttons[i] && !previous[i],
      released: (i) => !buttons[i] && previous[i]
    }
  }
  let result = sample(frame([8]), [8, 9])
  assert.equal(result.hit(8), false)
  result = sample(frame([8, 9]), [8, 9])
  assert.equal(result.triggered, true)
  result = sample(frame([8, 9]), [8, 9])
  assert.equal(result.triggered, false)
  result = sample(frame([]), [8, 9])
  assert.equal(result.hit(9), false)
  assert.equal(result.hit(8), false)
  sample(frame([9]), [8, 9])
  result = sample(frame([]), [8, 9])
  assert.equal(result.hit(9), true)
  sample(frame([9]), [8, 9], true) // Menu closes OSK on press.
  result = sample(frame([]), [8, 9], false)
  assert.equal(result.hit(9), false, 'OSK Menu release must not open Settings')
  sample(frame([9]), [8, 9])
  result = sample(frame([]), [8, 9])
  assert.equal(result.hit(9), true, 'Fresh Menu press still opens Settings')
})

test('expanded picker formats survive central import, library persistence and media IDs', async (t) => {
  const root = temp(t),
    sources = join(root, 'source'),
    games = join(root, 'games')
  fs.mkdirSync(sources)
  const exts = ['a26', 'a78', 'lnx', 'atx', 'rom', 'bin', 'zip', '7z', 'smd', 'gen', 'cue', 'v64']
  const files = exts.map((ext) => {
    const file = join(sources, 'Fixture.' + ext.toUpperCase())
    fs.writeFileSync(file, 'fixture')
    return file
  })
  const copies = await createGameImporter(games)(files)
  assert.equal(copies.length, files.length)
  const library = createLibraryStore(root)
  library.add(copies)
  assert.equal(createLibraryStore(root).list().length, files.length)
  for (const game of library.list()) assert.match(gameMediaId(game), /^[a-z0-9-]+$/)
  for (const ext of exts) assert(GAME_FILE_FILTERS[0].extensions.includes(ext))
  assert.deepEqual(GAME_FILE_FILTERS[1], { name: 'Tüm Dosyalar (*.*)', extensions: ['*'] })
  assert.equal(
    library.list().find((game) => game.fileName.endsWith('.ZIP')).systemShort,
    'Unassigned'
  )
})
