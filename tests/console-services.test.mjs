import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createCoreManager, extractCore } from '../src/main/services/coreManager.js'
import { createLibraryStore } from '../src/main/services/libraryStore.js'
import { biosStatus, deleteBios } from '../src/main/services/biosStatus.js'
import fixture from './fixtures/core-archive.cjs'
const { coreArchive } = fixture
const temporary = (t) => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'zenith-services-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
const manager = (root, fetchImpl) =>
  createCoreManager({ retroarchDir: root, fetchImpl, platform: 'win32', arch: 'x64' })
test('core install coalesces shared cores, caches DLL and has no partial files', async (t) => {
  const root = temporary(t)
  let calls = 0
  const cores = manager(root, async (url, options) => {
    calls++
    assert.equal(options.redirect, 'error')
    assert(options.signal)
    assert.equal(
      url,
      'https://buildbot.libretro.com/nightly/windows/x86_64/latest/dolphin_libretro.dll.zip'
    )
    return new Response(coreArchive('dolphin_libretro.dll'))
  })
  const results = await Promise.all([cores.install('Wii'), cores.install('GameCube')])
  assert(results.every((r) => r.success))
  assert.equal(calls, 1)
  assert.equal(cores.find('GameCube'), 'dolphin_libretro.dll')
  assert((await cores.install('Wii')).success)
  assert.equal(calls, 1)
  assert.deepEqual(fs.readdirSync(join(root, 'cores')), ['dolphin_libretro.dll'])
  assert.equal((await cores.install('__proto__')).success, false)
})
test('missing preferred PS2 core uses LRPS2 fallback', async (t) => {
  const urls = []
  const cores = manager(temporary(t), async (url) => {
    urls.push(url)
    return url.includes('pcsx2')
      ? new Response('', { status: 404 })
      : new Response(coreArchive('lrps2_libretro.dll'))
  })
  assert.deepEqual(await cores.install('PS2'), { success: true, core: 'lrps2_libretro.dll' })
  assert.equal(urls.length, 2)
})
test('invalid ZIP, oversized response and network failure never create a DLL', async (t) => {
  for (const fetchImpl of [
    async () => new Response(coreArchive('../mgba_libretro.dll')),
    async () => new Response('invalid'),
    async () => new Response('x', { headers: { 'content-length': String(201 * 1024 * 1024) } }),
    async () => {
      throw Error('timeout')
    }
  ]) {
    const root = temporary(t),
      cores = manager(root, fetchImpl)
    assert.equal((await cores.install('GBA')).success, false)
    assert.equal(cores.find('GBA'), null)
  }
  assert.throws(
    () => extractCore(coreArchive('mgba_libretro.dll', Buffer.alloc(256)), 'mgba_libretro.dll'),
    /Windows/
  )
  const broken = coreArchive('mgba_libretro.dll')
  const central = broken.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  broken.writeUInt32LE(0, central + 16)
  assert.throws(() => extractCore(broken, 'mgba_libretro.dll'), /checksum/)
})
test('library import persists, deduplicates, excludes and re-adds without changing ROMs', (t) => {
  const root = temporary(t),
    profile = join(root, 'profile'),
    rom = join(root, 'Example (PSP).iso')
  fs.writeFileSync(rom, 'synthetic fixture')
  let library = createLibraryStore(profile)
  assert.equal(library.add([rom, rom]), 1)
  assert.equal(library.list()[0].systemShort, 'PSP')
  library = createLibraryStore(profile)
  assert.equal(library.list().length, 1)
  library.remove(rom)
  assert(library.excluded(rom))
  assert.equal(library.list().length, 0)
  assert.equal(fs.readFileSync(rom, 'utf8'), 'synthetic fixture')
  library.add([rom])
  assert.equal(library.excluded(rom), false)
})
test('BIOS diagnostics reject empty dumps and check region-specific PS1 names', (t) => {
  const root = temporary(t),
    system = join(root, 'system'),
    ps2 = join(system, 'pcsx2', 'bios')
  fs.mkdirSync(ps2, { recursive: true })
  fs.writeFileSync(join(ps2, 'test.bin'), 'invalid small fixture')
  assert.equal(biosStatus(root, 'PS2').ready, false)
  fs.writeFileSync(join(ps2, 'test.bin'), Buffer.alloc(4 * 1024 * 1024))
  assert.equal(biosStatus(root, 'PS2').ready, true)
  fs.writeFileSync(join(system, 'scph5501.bin'), Buffer.alloc(512 * 1024))
  assert.equal(biosStatus(root, 'PS1', 'USA').ready, true)
  assert.equal(biosStatus(root, 'PS1', 'Europe').ready, false)
  assert.equal(biosStatus(root, 'PSP').required, false)
})

test('only PS2, PS1 and Dreamcast require BIOS; removal preserves unrelated files', async (t) => {
  const root = temporary(t),
    system = join(root, 'system')
  for (const platform of ['NDS', 'PSP', 'GBA', 'N64', 'SNES', 'NES'])
    assert.equal(biosStatus(root, platform).required, false)
  for (const platform of ['PS2', 'PS1', 'Dreamcast'])
    assert.equal(biosStatus(root, platform).ready, false)
  fs.mkdirSync(join(system, 'pcsx2', 'bios'), { recursive: true })
  fs.writeFileSync(join(system, 'scph5501.bin'), Buffer.alloc(512 * 1024))
  fs.writeFileSync(join(system, 'bios7.bin'), 'preserve NDS HLE/optional files')
  fs.writeFileSync(join(system, 'pcsx2', 'bios', 'SCPH.bin'), Buffer.alloc(4 * 1024 * 1024))
  fs.writeFileSync(join(system, 'pcsx2', 'bios', 'notes.txt'), 'preserve notes')
  await deleteBios(root, 'PS1')
  assert.equal(biosStatus(root, 'PS1').ready, false)
  assert.equal(biosStatus(root, 'PS2').ready, true)
  assert(fs.existsSync(join(system, 'bios7.bin')))
  await deleteBios(root, 'PS2')
  assert.equal(biosStatus(root, 'PS2').ready, false)
  assert(fs.existsSync(join(system, 'pcsx2', 'bios', 'notes.txt')))
  await assert.rejects(deleteBios(root, '../outside'))
  await assert.rejects(deleteBios(root, 'NDS'))
})
