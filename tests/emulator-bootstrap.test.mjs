import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sevenZip from '7zip-bin'
import {
  latestStable,
  validateListing,
  downloadArchive,
  setupEmulators
} from '../scripts/setup-emulators.mjs'
import { seedBundledRetroArch } from '../src/main/services/bundledRuntime.js'
import validatePackage from '../scripts/validate-emulators.cjs'
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import yaml from 'js-yaml'

const temporary = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-bootstrap-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('stable discovery sorts versions numerically; extraction refuses traversal and links', () => {
  assert.equal(
    latestStable('<a href="1.9.9/">x</a><a href="/stable/1.22.2/">x</a><a href="1.10.0/">x</a>'),
    '1.22.2'
  )
  assert.throws(() => latestStable('<a href="nightly/">'), /no versions/)
  validateListing('Path = RetroArch/retroarch.exe\nPath = RetroArch/assets/font.ttf')
  for (const name of ['../outside', 'C:\\outside', '/tmp/outside', 'folder/../../outside']) {
    assert.throws(() => validateListing('Path = ' + name), /Unsafe/)
  }
  assert.throws(() => validateListing('Path = file\nSymbolic Link = elsewhere'), /links/)
})

test('stream download enforces size, handles HTTP errors and removes partial files', async (t) => {
  const root = await temporary(t),
    target = path.join(root, 'archive.7z')
  const log = () => {}
  await downloadArchive('https://fixture', target, {
    log,
    fetchImpl: async () => new Response('fixture')
  })
  assert.equal(await fs.readFile(target, 'utf8'), 'fixture')
  await fs.unlink(target)
  await assert.rejects(
    downloadArchive('https://fixture', target, {
      log,
      maxBytes: 2,
      fetchImpl: async () => new Response('oversized')
    }),
    /limit/
  )
  await assert.rejects(fs.access(target))
  await assert.rejects(
    downloadArchive('https://fixture', target, {
      log,
      fetchImpl: async () => new Response(null, { status: 503 })
    }),
    /503/
  )
})

test('Windows bootstrap extracts a real 7z fixture, preserves user files and skips an existing install', async (t) => {
  const root = await temporary(t),
    fixture = path.join(root, 'fixture')
  await fs.mkdir(path.join(fixture, 'RetroArch', 'assets'), { recursive: true })
  await fs.writeFile(path.join(fixture, 'RetroArch', 'retroarch.exe'), 'MZsynthetic')
  await fs.writeFile(path.join(fixture, 'RetroArch', 'assets', 'font.txt'), 'asset')
  const archive = path.join(root, 'fixture.7z')
  if (process.platform !== 'win32') await fs.chmod(sevenZip.path7za, 0o755)
  await promisify(execFile)(sevenZip.path7za, ['a', archive, 'RetroArch'], {
    cwd: fixture,
    windowsHide: true
  })
  const bytes = await fs.readFile(archive)
  const dest = path.join(root, 'emulators', 'retroarch')
  await fs.mkdir(path.join(dest, 'system'), { recursive: true })
  await fs.writeFile(path.join(dest, 'system', 'private.txt'), 'keep')
  let calls = 0
  const options = {
    root,
    platform: 'win32',
    arch: 'x64',
    log: () => {},
    fetchImpl: async (url) => {
      calls++
      assert(url.startsWith('https://buildbot.libretro.com/stable/'))
      return url.endsWith('.7z')
        ? new Response(bytes)
        : new Response('<a href="1.22.2/">release</a>')
    }
  }
  assert.equal((await setupEmulators(options)).version, '1.22.2')
  assert.equal(await fs.readFile(path.join(dest, 'assets', 'font.txt'), 'utf8'), 'asset')
  assert.equal(await fs.readFile(path.join(dest, 'system', 'private.txt'), 'utf8'), 'keep')
  assert.equal((await setupEmulators(options)).existing, true)
  assert.equal(calls, 2)
  assert.deepEqual(await fs.readdir(path.join(root, 'emulators')), ['retroarch'])
  await validatePackage({ electronPlatformName: 'win32', packager: { projectDir: root } })
  await assert.rejects(
    validatePackage({ electronPlatformName: 'linux', packager: { projectDir: root } }),
    /missing or invalid/
  )
})

test('Linux setup creates the skeleton without fetching Windows binaries; unsupported hosts fail', async (t) => {
  const root = await temporary(t)
  const options = {
    root,
    arch: 'x64',
    log: () => {},
    fetchImpl: () => {
      throw Error('Unexpected network')
    }
  }
  assert.equal((await setupEmulators({ ...options, platform: 'linux' })).installed, false)
  await fs.access(path.join(root, 'emulators', 'retroarch', 'cores'))
  await assert.rejects(setupEmulators({ ...options, platform: 'darwin' }), /supports/)
})

test('packaged runtime seeds writable userData once, preserving existing cores and settings', async (t) => {
  const root = await temporary(t),
    resourcesPath = path.join(root, 'resources')
  const source = path.join(resourcesPath, 'emulators', 'retroarch'),
    dest = path.join(root, 'profile', 'retroarch')
  await fs.mkdir(source, { recursive: true })
  await fs.mkdir(dest, { recursive: true })
  await fs.writeFile(path.join(source, 'retroarch'), 'synthetic executable')
  await fs.writeFile(path.join(source, 'retroarch.cfg'), 'default')
  await fs.writeFile(path.join(dest, 'retroarch.cfg'), 'user preference')
  const options = { resourcesPath, retroarchDir: dest, platform: 'linux' }
  assert.equal(await seedBundledRetroArch(options), true)
  assert.equal(await fs.readFile(path.join(dest, 'retroarch.cfg'), 'utf8'), 'user preference')
  await fs.writeFile(path.join(source, 'retroarch'), 'new build')
  assert.equal(await seedBundledRetroArch(options), false)
  assert.equal(await fs.readFile(path.join(dest, 'retroarch'), 'utf8'), 'synthetic executable')
})

test('builder resource filter includes RetroArch dependencies but excludes BIOS, saves and placeholders', async () => {
  const config = yaml.load(
    await fs.readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  )
  const resource = config.extraResources[0]
  assert.equal(resource.from, 'emulators/retroarch')
  assert.equal(resource.to, 'emulators/retroarch')
  const source = path.resolve('emulators/retroarch')
  const accept = new FileMatcher(
    source,
    path.resolve('fixture-output'),
    (v) => v,
    resource.filter
  ).createFilter()
  const file = { isDirectory: () => false }
  for (const name of ['retroarch.exe', 'retroarch', 'avcodec.dll', 'assets/font.ttf', 'COPYING']) {
    assert.equal(accept(path.join(source, name), file), true, name)
  }
  for (const name of [
    'cores/stella_libretro.dll',
    'system/pcsx2/bios/scph.bin',
    'system/dc/dc_boot.bin',
    'saves/game.srm',
    'media/cover.png',
    'logs/session.log',
    'retroarch.cfg',
    'cores/.gitkeep',
    '.gitkeep'
  ]) {
    assert.equal(accept(path.join(source, name), file), false, name)
  }
})
