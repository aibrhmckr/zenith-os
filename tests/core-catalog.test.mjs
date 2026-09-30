import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createCoreCatalog, biosPlatformForCore } from '../src/main/services/coreCatalog.js'
import { createCoreManager } from '../src/main/services/coreManager.js'
import { coreArchive, coreBinary } from './fixtures/core-archive.cjs'
test('official catalog filters foreign paths, sorts aliases, caches offline and persists selection', async (t) => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'zenith-catalog-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'cores')
  fs.mkdirSync(directory)
  fs.writeFileSync(join(directory, 'local_libretro.dll'), coreBinary('local_libretro.dll'))
  const options = {
    retroarchDir: root,
    userData: join(root, 'profile'),
    platform: 'win32',
    fetchImpl: async () =>
      new Response(
        `<a href="stella_libretro.dll.zip">Stella</a><a href="mesen_libretro.dll.zip">Mesen</a><a href="https://evil.test/fake_libretro.dll.zip">evil</a><a href="../escape_libretro.dll.zip">escape</a><a href="linux_libretro.so.zip">wrong host</a>`
      )
  }
  const catalog = createCoreCatalog(options),
    result = await catalog.list()
  assert.equal(result.success, true)
  assert.deepEqual(
    result.cores.map((x) => x.fileName),
    ['local_libretro.dll', 'mesen_libretro.dll', 'stella_libretro.dll']
  )
  assert.equal(await catalog.allowed('../evil.dll'), false)
  assert.equal(await catalog.allowed('fake_libretro.dll'), false)
  assert.equal(await catalog.allowed('stella_libretro.dll'), true)
  await catalog.select('game:example', 'local_libretro.dll')
  const offline = createCoreCatalog({
    ...options,
    fetchImpl: async () => {
      throw Error('Offline')
    }
  })
  assert.equal((await offline.list()).offline, true)
  assert.equal(offline.get('example', 'Unassigned'), 'local_libretro.dll')
  await offline.forget('example')
  assert.equal(offline.get('example', 'Unassigned'), null)
  assert.equal(biosPlatformForCore('lrps2_libretro.so', 'Unassigned'), 'PS2')
})
test('Atari defaults and a browsed core use the same validated installer', async (t) => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'zenith-atari-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manager = createCoreManager({
    retroarchDir: root,
    platform: 'win32',
    fetchImpl: async (url) =>
      new Response(
        coreArchive(
          url
            .split('/')
            .at(-1)
            .replace(/\.zip$/, '')
        )
      )
  })
  for (const [system, name] of [
    ['Atari 2600', 'stella'],
    ['Atari 7800', 'prosystem'],
    ['Atari Lynx', 'mednafen_lynx']
  ]) {
    assert.equal((await manager.install(system)).core, name + '_libretro.dll')
    assert.equal(manager.find(system), name + '_libretro.dll')
  }
  assert.equal((await manager.installNamed('desmume_libretro.dll')).success, true)
  assert.equal((await manager.installNamed('../evil_libretro.dll')).success, false)
  assert.equal((await manager.installNamed('stella_libretro.so')).success, false)
})
