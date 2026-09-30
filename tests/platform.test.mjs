import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runtimePaths, pathKey } from '../src/main/services/platform.js'
import { coreFilesFor, createCoreManager, extractCore } from '../src/main/services/coreManager.js'
import { biosStatus } from '../src/main/services/biosStatus.js'
import fixture from './fixtures/core-archive.cjs'

test('Windows portable and Linux AppImage/deb paths use native executable names and writable roots', () => {
  const linux = runtimePaths({
    platform: 'linux',
    packaged: true,
    appPath: '/tmp/.mount_zenith/app',
    executable: '/tmp/.mount_zenith/zenith',
    userData: '/home/deck/.config/zenith'
  })
  assert.equal(linux.retroarchExecutable, '/home/deck/.config/zenith/emulators/retroarch/retroarch')
  assert.equal(linux.gamesDirectory, '/home/deck/.config/zenith/games')
  const windows = runtimePaths({
    platform: 'win32',
    packaged: true,
    executable: 'C:\\Temp\\unpacked\\zenith.exe',
    userData: 'C:\\Profile',
    portableDirectory: 'D:\\Zenith'
  })
  assert.equal(windows.retroarchExecutable, 'C:\\Profile\\emulators\\retroarch\\retroarch.exe')
  assert.equal(windows.gamesDirectory, 'D:\\Zenith\\games')
  const development = runtimePaths({
    platform: 'linux',
    appPath: '/code/zenith',
    userData: '/home/deck/.config/zenith'
  })
  assert.equal(development.gamesDirectory, '/home/deck/.config/zenith/games')
  assert.notEqual(pathKey('/roms/Game.iso', 'linux'), pathKey('/roms/game.iso', 'linux'))
  assert.equal(pathKey('C:\\roms\\Game.iso', 'win32'), pathKey('C:\\roms\\game.iso', 'win32'))
})

test('Linux downloads .so.zip from the Linux buildbot and rejects Windows/incorrect ELF cores', async (t) => {
  const unlink = fs.promises.unlink
  t.mock.method(fs.promises, 'unlink', async (file, ...args) => {
    assert(!String(file).includes(':Zone.Identifier'), 'Linux must not access Windows metadata')
    return unlink(file, ...args)
  })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-linux-core-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert(coreFilesFor('linux').PS2.every((name) => name.endsWith('.so')))
  assert(coreFilesFor('win32').PS2.every((name) => name.endsWith('.dll')))
  const manager = createCoreManager({
    retroarchDir: root,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async (url) => {
      assert.equal(
        url,
        'https://buildbot.libretro.com/nightly/linux/x86_64/latest/mgba_libretro.so.zip'
      )
      return new Response(fixture.coreArchive('mgba_libretro.so'))
    }
  })
  assert.deepEqual(await manager.install('GBA'), { success: true, core: 'mgba_libretro.so' })
  assert.equal(manager.find('GBA'), 'mgba_libretro.so')
  assert.equal(
    fs.readFileSync(path.join(root, 'cores', 'mgba_libretro.so')).readUInt32BE(0),
    0x7f454c46
  )
  assert.throws(
    () => extractCore(fixture.coreArchive('mgba_libretro.dll'), 'mgba_libretro.dll', 'linux'),
    /Linux/
  )
  const bad = Buffer.alloc(64)
  bad.writeUInt32BE(0x7f454c46)
  bad[4] = 1
  bad[5] = 1
  assert.throws(
    () => extractCore(fixture.coreArchive('mgba_libretro.so', bad), 'mgba_libretro.so'),
    /Linux/
  )
})

test('Linux BIOS diagnosis respects exact names while Windows stays case-insensitive', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-linux-bios-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'system'))
  fs.writeFileSync(path.join(root, 'system', 'SCPH5501.BIN'), Buffer.alloc(512 * 1024))
  assert.equal(biosStatus(root, 'PS1', 'USA', 'linux').ready, false)
  assert.equal(biosStatus(root, 'PS1', 'USA', 'win32').ready, true)
})
