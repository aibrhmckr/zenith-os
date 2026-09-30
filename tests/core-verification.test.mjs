import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createCoreManager } from '../src/main/services/coreManager.js'
import { createCoreCatalog } from '../src/main/services/coreCatalog.js'
import { coreArchive, coreBinary } from './fixtures/core-archive.cjs'

const name = 'mupen64plus_next_libretro.dll'
function fixture(t, fetchImpl = async () => new Response(coreArchive(name))) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'zenith-core-verify-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const retroarchDir = join(root, 'profile', 'emulators', 'retroarch')
  const options = {
    retroarchDir,
    userData: join(root, 'profile'),
    platform: 'win32',
    arch: 'x64',
    fetchImpl
  }
  return {
    root,
    destination: join(retroarchDir, 'cores', name),
    manager: createCoreManager(options),
    catalog: createCoreCatalog(options)
  }
}

test('N64 status and launch path follow the installed file, never saved selection or a different runtime', async (t) => {
  const { root, destination, manager, catalog } = fixture(t)
  const wrongRuntime = join(root, 'resources', 'emulators', 'retroarch', 'cores')
  fs.mkdirSync(wrongRuntime, { recursive: true })
  fs.writeFileSync(join(wrongRuntime, name), coreBinary(name))
  await catalog.select('platform:N64', name)
  assert.equal(manager.find('N64'), null)
  assert.equal(catalog.get(null, 'N64'), null)
  assert.equal((await manager.install('N64')).success, true)
  assert.deepEqual(fs.readFileSync(destination), coreBinary(name))
  assert.equal(manager.pathFor(name), destination)
  assert.equal(catalog.get(null, 'N64'), name)
  fs.unlinkSync(destination)
  assert.equal(manager.find('N64'), null)
  assert.equal(manager.pathFor(name), null)
  assert.equal(catalog.get(null, 'N64'), null)
})

test('empty, HTML and wrong-platform cores are missing and can be repaired', async (t) => {
  const { destination, manager } = fixture(t)
  fs.mkdirSync(join(destination, '..'), { recursive: true })
  for (const invalid of [
    Buffer.alloc(0),
    Buffer.from('<html>error</html>'),
    coreBinary('wrong_libretro.so')
  ]) {
    fs.writeFileSync(destination, invalid)
    assert.equal(manager.find('N64'), null)
    assert.equal((await manager.install('N64')).success, true)
    assert.equal(manager.find('N64'), name)
  }
})

test('HTTP and timeout failures expose the source, target and reason', async (t) => {
  for (const fetchImpl of [
    async () => new Response('', { status: 503 }),
    async () => {
      throw Error('timeout')
    }
  ]) {
    const { destination, manager } = fixture(t, fetchImpl)
    const result = await manager.install('N64')
    assert.equal(result.success, false)
    assert.match(result.error, /HTTP 503|timeout/)
    assert(result.error.includes(destination))
    assert.match(result.error, /https:\/\/buildbot.libretro.com/)
    assert.equal(manager.find('N64'), null)
  }
})

test('permission errors and a file disappearing after publish cannot report successful installation', async (t) => {
  const { destination, manager } = fixture(t)
  const realRename = fs.promises.rename
  const denied = t.mock.method(fs.promises, 'rename', async () => {
    throw Object.assign(Error('Access denied'), { code: 'EPERM' })
  })
  let result = await manager.install('N64')
  assert.equal(result.success, false)
  assert.match(result.error, /write failed \(EPERM\)/)
  assert.equal(manager.find('N64'), null)
  denied.mock.restore()
  t.mock.method(fs.promises, 'rename', async (...args) => {
    await realRename(...args)
    await fs.promises.unlink(destination)
  })
  result = await manager.install('N64')
  assert.equal(result.success, false)
  assert.match(result.error, /verify failed/)
  assert.equal(manager.find('N64'), null)
  assert.deepEqual(fs.readdirSync(join(destination, '..')), [])
})

test('post-write content mismatch removes the bad core instead of leaving a Ready file', async (t) => {
  const { destination, manager } = fixture(t)
  const rename = fs.promises.rename
  t.mock.method(fs.promises, 'rename', async (...args) => {
    await rename(...args)
    const changed = coreBinary(name)
    changed[200] = 1
    fs.writeFileSync(destination, changed)
  })
  const result = await manager.install('N64')
  assert.equal(result.success, false)
  assert.match(result.error, /verify failed/)
  assert.equal(manager.find('N64'), null)
  assert(!fs.existsSync(destination))
})

test(
  'Windows clears only the newly downloaded core attachment stream before publishing',
  {
    skip: process.platform !== 'win32'
  },
  async (t) => {
    const { destination, manager } = fixture(t)
    const writeFile = fs.promises.writeFile
    let markedFile
    t.mock.method(fs.promises, 'writeFile', async (file, ...args) => {
      await writeFile(file, ...args)
      if (String(file).endsWith('.part')) {
        assert(Buffer.isBuffer(args[0]), 'Installer must write native Buffer bytes')
        markedFile = String(file)
        await writeFile(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
        assert(fs.existsSync(`${file}:Zone.Identifier`))
      }
    })
    const rename = fs.promises.rename
    t.mock.method(fs.promises, 'rename', async (from, to) => {
      assert.equal(from, markedFile)
      assert(!fs.existsSync(`${from}:Zone.Identifier`), 'Stream removed before atomic publication')
      return rename(from, to)
    })
    assert.equal((await manager.install('N64')).success, true)
    assert(!fs.existsSync(`${destination}:Zone.Identifier`))
    assert.deepEqual(fs.readFileSync(destination), coreBinary(name))
    // A manually installed binary is outside the download cleanup scope.
    fs.writeFileSync(`${destination}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
    assert.equal((await manager.install('N64')).success, true)
    assert(fs.existsSync(`${destination}:Zone.Identifier`))
  }
)

test('Windows metadata cleanup permission failure is visible and never publishes a partial core', async (t) => {
  const { destination, manager } = fixture(t)
  const unlink = fs.promises.unlink
  t.mock.method(fs.promises, 'unlink', async (file, ...args) => {
    if (String(file).endsWith(':Zone.Identifier'))
      throw Object.assign(Error('Access denied'), { code: 'EPERM' })
    return unlink(file, ...args)
  })
  const result = await manager.install('N64')
  assert.equal(result.success, false)
  assert.match(result.error, /Windows metadata cleanup failed \(EPERM\)/)
  assert(!fs.existsSync(destination))
  assert.deepEqual(fs.readdirSync(join(destination, '..')), [])
})
