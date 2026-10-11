import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createCoreCatalog, biosPlatformForCore } from '../src/main/services/coreCatalog.js'
import { createCoreManager, CORE_UPDATE_INTERVAL_MS } from '../src/main/services/coreManager.js'
import { coreArchive, coreBinary } from './fixtures/core-archive.cjs'

test('core cooldown persists across managers, expires after 24h and never masks missing or replaced files', async (t) => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'zenith-core-cooldown-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const name = 'mgba_libretro.dll',
    target = join(root, 'cores', name)
  let clock = 100000,
    requests = 0,
    fail = false
  const events = []
  const options = {
    retroarchDir: root,
    platform: 'win32',
    arch: 'x64',
    now: () => clock,
    onProgress: (event) => events.push(event),
    fetchImpl: async () => {
      requests++
      return fail ? new Response('', { status: 503 }) : new Response(coreArchive(name))
    }
  }
  await createCoreManager(options).installNamed(name)
  assert.equal(requests, 1)
  events.length = 0
  clock += CORE_UPDATE_INTERVAL_MS - 1
  assert.equal((await createCoreManager(options).installNamed(name, true)).upToDate, true)
  assert.equal(requests, 1)
  assert.deepEqual(events, [])
  clock++
  const receipt = target + '.zenith-update.json'
  const previous = fs.readFileSync(receipt, 'utf8')
  fail = true
  assert.equal((await createCoreManager(options).installNamed(name, true)).success, false)
  assert.equal(fs.readFileSync(receipt, 'utf8'), previous)
  fail = false
  assert.equal((await createCoreManager(options).installNamed(name, true)).success, true)
  assert.equal(requests, 3)
  fs.unlinkSync(target)
  await createCoreManager(options).installNamed(name, true)
  assert.equal(requests, 4)
  fs.appendFileSync(target, 'locally changed')
  await createCoreManager(options).installNamed(name, true)
  assert.equal(requests, 5)
  fs.writeFileSync(receipt, 'invalid')
  await createCoreManager(options).installNamed(name, true)
  assert.equal(requests, 6)
})

test('installed core update fetches new bytes, reports progress and preserves saves/config', async (t) => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'zenith-core-update-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(join(root, 'cores'))
  const name = 'mgba_libretro.dll',
    target = join(root, 'cores', name)
  fs.writeFileSync(target, coreBinary(name))
  fs.writeFileSync(join(root, 'retroarch.cfg'), 'user configuration')
  fs.mkdirSync(join(root, 'saves'))
  fs.writeFileSync(join(root, 'saves', 'demo.srm'), 'save')
  const events = []
  let requests = 0
  const manager = createCoreManager({
    retroarchDir: root,
    platform: 'win32',
    arch: 'x64',
    onProgress: (e) => events.push(e),
    fetchImpl: async () => {
      requests++
      const archive = coreArchive(name)
      return new Response(archive, { headers: { 'content-length': String(archive.length) } })
    }
  })
  assert.equal((await manager.installNamed(name)).success, true)
  assert.equal(requests, 0)
  const task = manager.installNamed(name, true)
  assert.equal(manager.busy(), true)
  assert.equal((await task).success, true)
  assert.equal(manager.busy(), false)
  assert.equal(requests, 1)
  assert(events.some((e) => e.received > 0 && e.total > 0))
  assert.equal(events.at(-1).status, 'completed')
  assert.deepEqual(fs.readFileSync(target), coreBinary(name))
  assert.equal(fs.readFileSync(join(root, 'retroarch.cfg'), 'utf8'), 'user configuration')
  assert.equal(fs.readFileSync(join(root, 'saves', 'demo.srm'), 'utf8'), 'save')
  assert(!fs.readdirSync(join(root, 'cores')).some((n) => /part|backup/.test(n)))
})
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
