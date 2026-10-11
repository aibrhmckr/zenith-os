import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { inspectIso, detectGamePlatform } from '../src/main/services/discInspector.js'
import { createLibraryStore } from '../src/main/services/libraryStore.js'
import { createGameImporter } from '../src/main/services/gameImporter.js'
const { discImage } = createRequire(import.meta.url)('./fixtures/disc-image.cjs')
const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-disc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('ISO root metadata distinguishes PS3, PSP, PS2 and PS1 without filename hints', (t) => {
  const root = fixture(t),
    file = path.join(root, 'Blur (USA).iso')
  let modified = 1700000000
  for (const system of ['PS3', 'PSP', 'PS2', 'PS1']) {
    fs.writeFileSync(file, discImage(system))
    // Distinct synthetic rewrites must invalidate the size/mtime cache even on coarse Windows clocks.
    fs.utimesSync(file, modified, modified++)
    assert.equal(inspectIso(file), system)
    assert.equal(detectGamePlatform(file), system)
  }
  const header = Buffer.alloc(4096)
  header.write('PlayStation3', 0x800)
  fs.writeFileSync(file, header)
  assert.equal(inspectIso(file), 'PS3')
  const pvd = discImage('PS2')
  pvd.write('PS3', 16 * 2048 + 8)
  fs.writeFileSync(file, pvd)
  assert.equal(inspectIso(file), 'PS3')
})

test('bounded malformed discs fall back to PS3; explicit PS3 and PSP path hints remain usable', (t) => {
  const root = fixture(t),
    file = path.join(root, 'unknown.iso')
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from('payload PS3_GAME text'),
    (() => {
      const b = discImage('PS2')
      b.writeUInt32LE(0xffffffff, 16 * 2048 + 166)
      return b
    })()
  ]) {
    fs.writeFileSync(file, bytes)
    assert.equal(inspectIso(file), null)
    assert.equal(detectGamePlatform(file), 'PS3')
  }
  assert.equal(detectGamePlatform(path.join(root, 'Game (PSP).iso')), 'PSP')
  const named = path.join(root, 'Game (PS3).iso')
  fs.writeFileSync(named, discImage('PS2'))
  assert.equal(detectGamePlatform(named), 'PS3')
})

test('manual platform overrides survive restart and reimport and can reset to disc detection', async (t) => {
  const root = fixture(t),
    file = path.join(root, 'Blur.iso'),
    profile = path.join(root, 'profile')
  fs.writeFileSync(file, discImage('PS3'))
  let library = createLibraryStore(profile)
  library.add([file])
  library.setPlatform(file, 'PS2')
  assert.equal(library.list()[0].systemShort, 'PS2')
  library = createLibraryStore(profile)
  library.add([file])
  assert.equal(library.platformFor(file), 'PS2')
  library.setPlatform(file, 'PS3')
  assert.equal(library.list()[0].platformOverride, 'PS3')
  library.setPlatform(file, null)
  assert.equal(library.platformFor(file), 'PS3')
  assert.equal(library.platformOverride(file), null)
  assert.throws(() => library.setPlatform(file, 'malicious'), 'Unsupported')
  const imported = await createGameImporter(path.join(root, 'games'))([file])
  assert.equal(detectGamePlatform(imported[0]), 'PS3')
  assert.equal(library.platformFor(path.join(root, 'test.gba')), 'GBA')
})
