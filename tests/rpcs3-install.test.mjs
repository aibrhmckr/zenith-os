import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import sevenZip from '7zip-bin'
import { createRpcs3Runtime } from '../src/main/services/rpcs3Runtime.js'
import {
  downloadRpcs3,
  selectRpcs3Asset,
  validateRpcs3Listing,
  clearDownloadedZone
} from '../src/main/services/rpcs3Download.js'
import { installRpcs3Content, runRpcs3Installer } from '../src/main/services/rpcs3Content.js'
const { coreBinary } = createRequire(import.meta.url)('./fixtures/core-archive.cjs')
const exec = promisify(execFile)

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-rpcs3-install-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const runtime = createRpcs3Runtime({ userData: root, platform: 'win32' })
  runtime.ensureDirectories()
  const source = path.join(root, 'source')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'rpcs3.exe'), coreBinary('fixture.exe'))
  await fs.writeFile(path.join(source, 'support.txt'), 'synthetic support')
  await fs.writeFile(path.join(source, 'runtime.dll'), coreBinary('runtime.dll'))
  for (const name of [
    'config/default.yml',
    'config.yml',
    'dev_hdd0/game/keep.txt',
    'portable/config.yml',
    'Config/injected.dll',
    'dev_flash/firmware.PUP',
    'plugins/Qt platform.dll'
  ]) {
    const file = path.join(source, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'synthetic archive member')
  }
  const archive = path.join(root, 'fixture.7z')
  await exec(sevenZip.path7za, ['a', archive, '.'], { cwd: source, windowsHide: true })
  const bytes = await fs.readFile(archive)
  const asset = {
    name: 'rpcs3-fixture_win64_msvc.7z',
    size: bytes.length,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    browser_download_url:
      'https://github.com/RPCS3/rpcs3-binaries-win/releases/download/test/rpcs3-fixture_win64_msvc.7z'
  }
  const fetchImpl = async (url) =>
    url.includes('/releases/latest') ? Response.json({ assets: [asset] }) : new Response(bytes)
  const firmware = async () => {
    const flash = runtime.status().firmware.directory
    await fs.mkdir(path.join(flash, 'sys/external'), { recursive: true })
    await fs.mkdir(path.join(flash, 'vsh/etc'), { recursive: true })
    await fs.writeFile(path.join(flash, 'sys/external/liblv2.sprx'), Buffer.from([83, 67, 69, 0]))
    await fs.writeFile(path.join(flash, 'vsh/etc/version.txt'), 'release:04.9200:')
  }
  return { root, runtime, bytes, asset, fetchImpl, firmware }
}

test('RPCS3 official download verifies digest/CRC, preserves profile and publishes complete x64 runtime', async (t) => {
  const f = await fixture(t),
    phases = []
  await fs.writeFile(path.join(f.runtime.configDirectory, 'keep.txt'), 'user settings')
  const result = await downloadRpcs3({
    ...f,
    platform: 'win32',
    arch: 'x64',
    progress: (p) => phases.push(p.phase)
  })
  assert.equal(result.success, true)
  assert.equal(result.status.executableReady, true)
  assert.equal(result.status.firmware.ready, false)
  assert.equal(
    await fs.readFile(path.join(f.runtime.configDirectory, 'keep.txt'), 'utf8'),
    'user settings'
  )
  assert.deepEqual(
    await fs.readFile(path.join(f.runtime.directory, 'runtime.dll')),
    coreBinary('runtime.dll')
  )
  assert.equal(
    await fs.readFile(path.join(f.runtime.directory, 'plugins/Qt platform.dll'), 'utf8'),
    'synthetic archive member'
  )
  for (const name of ['support.txt', 'config.yml', 'config', 'dev_hdd0', 'Config', 'dev_flash'])
    assert.equal(await fs.stat(path.join(f.runtime.directory, name)).catch(() => null), null)
  assert(phases.includes('verifying'))
  assert(phases.includes('complete'))
  assert.equal(
    (await fs.readdir(path.dirname(f.runtime.directory))).some((n) =>
      n.startsWith('.rpcs3-download-')
    ),
    false
  )
})

test('RPCS3 rejects foreign assets, missing hashes, malicious entries and oversize extraction', () => {
  assert.throws(() => selectRpcs3Asset({ assets: [] }), /not found/)
  for (const name of [
    '../rpcs3.exe',
    'C:/rpcs3.exe',
    'rpcs3.exe:Zone.Identifier',
    'CON.txt',
    'x/../x',
    'config/../escape.dll'
  ])
    assert.throws(() => validateRpcs3Listing('Path = ' + name + '\nSize = 1\n'), /Unsafe/)
  assert.throws(() => validateRpcs3Listing('Path = rpcs3.exe\nSize = 3000000000'), /limit/)
  assert.throws(
    () => validateRpcs3Listing('Path = rpcs3.exe\nSize = 1\nSymbolic Link = elsewhere'),
    /Unsafe/
  )
})

test('RPCS3 listing ignores profile templates and firmware but retains exact binary paths', () => {
  const names = [
    'rpcs3.exe',
    'runtime.dll',
    'plugins/Qt platform.dll',
    'config',
    'config.yml',
    'CONFIG/nested/plugin.dll',
    'dev_hdd0/game/EBOOT.BIN',
    'portable/rpcs3.exe',
    'dev_flash/firmware.PUP',
    'input_configs/pad.dll',
    'README.txt'
  ]
  const listing = names.map((name) => `Path = ${name}\nSize = 1\n`).join('\n')
  assert.deepEqual(
    validateRpcs3Listing(listing).map((entry) => entry.Path),
    names.slice(0, 3)
  )
  for (const extra of [
    'Path = config/../../escape.dll\nSize = 1',
    'Path = config/link\nSymbolic Link = ../../outside',
    'Path = config/link\nHard Link = ../../outside',
    'Path = config.yml:Zone.Identifier\nSize = 1',
    'Path = RUNTIME.DLL\nSize = 1'
  ])
    assert.throws(() => validateRpcs3Listing(listing + '\n' + extra), /Unsafe/)
  assert.throws(
    () => validateRpcs3Listing('Path = rpcs3.exe\nFolder = +\nSize = 0'),
    /must contain/
  )
})

test('RPCS3 binary update preserves existing support files, firmware and virtual disk', async (t) => {
  const f = await fixture(t)
  const options = { ...f, platform: 'win32', arch: 'x64' }
  await downloadRpcs3(options)
  await f.firmware()
  const support = path.join(f.runtime.directory, 'support.txt')
  await fs.writeFile(support, 'user support')
  const saved = path.join(f.runtime.configDirectory, 'dev_hdd0', 'savedata', 'demo')
  await fs.mkdir(path.dirname(saved), { recursive: true })
  await fs.writeFile(saved, 'saved game')
  const config = path.join(f.runtime.directory, 'config.yml')
  await fs.writeFile(config, 'user configuration')
  let inspected = false
  const execImpl = async (binary, args, opts) => {
    const result = await exec(binary, args, opts)
    if (args[0] === 'x') {
      inspected = true
      const extracted = args.find((arg) => arg.startsWith('-o')).slice(2)
      assert.deepEqual((await fs.readdir(extracted)).sort(), [
        'plugins',
        'rpcs3.exe',
        'runtime.dll'
      ])
      assert(args.includes('-spd'))
      assert(args.some((arg) => arg.startsWith('-i@')))
    }
    return result
  }
  const phases = []
  assert.equal(
    (
      await downloadRpcs3({
        ...options,
        update: true,
        fetchImpl: async (url) =>
          url.includes('/releases/latest')
            ? Response.json({ tag_name: 'new-release', assets: [f.asset] })
            : new Response(f.bytes),
        execImpl,
        progress: (p) => phases.push(p.phase)
      })
    ).success,
    true
  )
  assert(inspected, 'Excluded content never reaches the extraction directory')
  assert.equal(phases.at(-1), 'complete')
  assert.equal(await fs.readFile(config, 'utf8'), 'user configuration')
  assert.equal(await fs.readFile(support, 'utf8'), 'user support')
  assert.equal(await fs.readFile(saved, 'utf8'), 'saved game')
  assert.equal(f.runtime.status().firmware.ready, true)
})

test('RPCS3 remembers the installed release, skips matching assets and repairs a missing executable', async (t) => {
  const f = await fixture(t)
  let tag = 'v1',
    downloads = 0,
    lookups = 0
  const phases = []
  const options = {
    ...f,
    platform: 'win32',
    arch: 'x64',
    progress: (value) => phases.push(value.phase),
    fetchImpl: async (url) => {
      if (url.includes('/releases/latest')) {
        lookups++
        return Response.json({ tag_name: tag, assets: [f.asset] })
      }
      downloads++
      return new Response(f.bytes)
    }
  }
  await downloadRpcs3(options)
  const receipt = path.join(f.runtime.directory, 'zenith-release.json')
  assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).installedVersion, 'v1')
  phases.length = 0
  assert.equal((await downloadRpcs3({ ...options, update: true })).upToDate, true)
  assert.equal(downloads, 1)
  assert.equal(lookups, 2)
  assert.deepEqual(phases, [], 'A matching release creates no download task')
  tag = 'v2'
  await downloadRpcs3({ ...options, update: true })
  assert.equal(downloads, 2)
  assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).installedVersion, 'v2')
  await fs.unlink(path.join(f.runtime.directory, 'rpcs3.exe'))
  await downloadRpcs3({ ...options, update: true })
  assert.equal(downloads, 3, 'A receipt cannot mask a missing executable')
  tag = 'v3'
  const goodDigest = f.asset.digest
  f.asset.digest = 'sha256:' + '0'.repeat(64)
  await assert.rejects(downloadRpcs3({ ...options, update: true }), /SHA-256/)
  assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).installedVersion, 'v2')
  f.asset.digest = goodDigest
  await fs.writeFile(receipt, '{invalid')
  await downloadRpcs3({ ...options, update: true })
  assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).installedVersion, 'v3')
})

test('bad SHA-256, redirect, network errors and rollback never publish a ready executable', async (t) => {
  const f = await fixture(t)
  const options = { ...f, platform: 'win32', arch: 'x64' }
  f.asset.digest = 'sha256:' + '0'.repeat(64)
  await assert.rejects(downloadRpcs3(options), /SHA-256/)
  assert.equal(f.runtime.status().executableReady, false)
  await assert.rejects(
    downloadRpcs3({
      ...options,
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.invalid/a' } })
    }),
    /Untrusted/
  )
  await assert.rejects(
    downloadRpcs3({ ...options, fetchImpl: async () => new Response('', { status: 403 }) }),
    /403/
  )
  f.asset.digest = 'sha256:' + createHash('sha256').update(f.bytes).digest('hex')
  const support = path.join(f.runtime.directory, 'support.txt')
  await fs.writeFile(support, 'original')
  const originalDll = Buffer.from('previous DLL preserved by rollback')
  await fs.writeFile(path.join(f.runtime.directory, 'runtime.dll'), originalDll)
  let checks = 0
  const runtime = {
    ...f.runtime,
    status: () => {
      checks++
      return { ...f.runtime.status(), executableReady: false }
    }
  }
  await assert.rejects(downloadRpcs3({ ...options, runtime }), /failed verification/)
  assert(checks >= 2)
  assert.equal(await fs.readFile(support, 'utf8'), 'original')
  assert.deepEqual(await fs.readFile(path.join(f.runtime.directory, 'runtime.dll')), originalDll)
  assert.equal(f.runtime.status().executableReady, false)
})

test('Zone.Identifier cleanup ignores only absent streams; cancellation leaves no downloaded runtime', async (t) => {
  await clearDownloadedZone('owned', async () => {
    throw Object.assign(Error(), { code: 'ENOENT' })
  })
  await assert.rejects(
    clearDownloadedZone('owned', async () => {
      throw Object.assign(Error('locked'), { code: 'EPERM' })
    }),
    /locked/
  )
  const f = await fixture(t),
    controller = new AbortController()
  controller.abort()
  await assert.rejects(
    downloadRpcs3({ ...f, platform: 'win32', arch: 'x64', signal: controller.signal })
  )
  assert.equal(f.runtime.status().executableReady, false)
})

async function input(f, kind) {
  await fs.writeFile(f.runtime.executable, coreBinary('rpcs3.exe'))
  const data = Buffer.alloc(256)
  if (kind === 'firmware') Buffer.from([83, 67, 69, 85, 70, 0, 0, 0]).copy(data)
  else {
    data.writeUInt32BE(0x7f504b47)
    data.write('UP0001-NPUB12345_00-FIXTURE0000000000', 0x30)
  }
  const file = path.join(f.root, kind === 'firmware' ? 'user firmware.PUP' : 'update.pkg')
  await fs.writeFile(file, data)
  return file
}

test('firmware CLI uses --headless --installfw and physical readiness rather than success text', async (t) => {
  const f = await fixture(t),
    file = await input(f, 'firmware')
  const original = await fs.readFile(file)
  const run = async (executable, args, opts) => {
    assert.equal(executable, f.runtime.executable)
    assert.deepEqual(args.slice(0, 2), ['--headless', '--installfw'])
    assert.notEqual(args[2], file)
    assert.equal(opts.cwd, f.runtime.directory)
    assert.deepEqual(await fs.readFile(args[2]), original)
    await f.firmware()
    return 'Successfully installed PS3 firmware version 4.92.'
  }
  const result = await installRpcs3Content({ ...f, kind: 'firmware', file, run, platform: 'win32' })
  assert.equal(result.status.firmware.ready, true)
  assert.deepEqual(await fs.readFile(file), original)
  // A valid physical installation remains ready even if no success log was emitted.
  assert.equal(
    (
      await installRpcs3Content({
        ...f,
        kind: 'firmware',
        file,
        run: async () => '',
        platform: 'win32'
      })
    ).success,
    true
  )
  assert.equal(
    (await fs.readdir(path.dirname(f.runtime.directory))).some((n) =>
      n.startsWith('.rpcs3-content-')
    ),
    false
  )
})

test('PKG CLI requires title-specific success and installed PARAM.SFO; corrupt inputs never spawn', async (t) => {
  const f = await fixture(t),
    file = await input(f, 'package')
  const run = async (_exe, args) => {
    assert.deepEqual(args.slice(0, 2), ['--headless', '--installpkg'])
    const target = path.join(f.runtime.dataDirectory('dev_hdd0'), 'game/NPUB12345')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'PARAM.SFO'), Buffer.from([0, 80, 83, 70]))
    return 'Successfully installed input.pkg (title_id=NPUB12345, title=Fixture, version=1.00).'
  }
  assert.equal(
    (await installRpcs3Content({ ...f, kind: 'package', file, run, platform: 'win32' })).titleId,
    'NPUB12345'
  )
  await assert.rejects(
    installRpcs3Content({
      ...f,
      kind: 'package',
      file,
      run: async () => 'Successfully installed input.pkg (title_id=NPUB99999, title=Other).',
      platform: 'win32'
    }),
    /did not confirm/
  )
  await fs.writeFile(file, Buffer.alloc(256))
  await assert.rejects(
    installRpcs3Content({
      ...f,
      kind: 'package',
      file,
      run: () => assert.fail('must not spawn'),
      platform: 'win32'
    }),
    /Invalid PS3 PKG/
  )
})

test('installer process timeout/cancel and nonzero close reject; shell is never used', async () => {
  let child
  const spawnImpl = (_exe, _args, options) => {
    assert.equal(options.shell, false)
    assert.equal(options.windowsHide, true)
    child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => child.emit('close', null)
    return child
  }
  await assert.rejects(
    runRpcs3Installer('fake', [], { cwd: '.', spawnImpl, timeoutMs: 10 }),
    /timed out/
  )
  const pending = runRpcs3Installer('fake', [], { cwd: '.', spawnImpl })
  child.emit('close', 1)
  await assert.rejects(pending, (e) => e.code === 'RPCS3_INSTALL_EXIT' && e.exitCode === 1)
})

test('firmware teardown crash succeeds only with valid disk state; operational failures remain errors', async (t) => {
  const f = await fixture(t),
    file = await input(f, 'firmware')
  const exitError = Object.assign(Error('RPCS3 installer exited (3221226505).'), {
    code: 'RPCS3_INSTALL_EXIT',
    exitCode: 3221226505
  })
  const fail = async () => {
    throw exitError
  }
  const options = { ...f, kind: 'firmware', file, platform: 'win32' }
  await assert.rejects(installRpcs3Content({ ...options, run: fail }), /3221226505/)
  await assert.rejects(
    installRpcs3Content({ ...options, run: async () => '' }),
    /valid installed firmware/
  )
  const result = await installRpcs3Content({
    ...options,
    run: async () => {
      await f.firmware()
      throw exitError
    }
  })
  assert.equal(result.success, true)
  assert.equal(result.status.firmware.ready, true)
  assert.equal(result.error, undefined)
  // Existing valid firmware is also sufficient after a completed child exit.
  assert.equal((await installRpcs3Content({ ...options, run: fail })).success, true)
  for (const error of [Error('spawn failed'), Error('canceled or timed out')]) {
    await assert.rejects(
      installRpcs3Content({
        ...options,
        run: async () => {
          throw error
        }
      }),
      (e) => e === error
    )
  }
  const controller = new AbortController()
  await assert.rejects(
    installRpcs3Content({
      ...options,
      signal: controller.signal,
      run: async () => {
        controller.abort()
        throw exitError
      }
    }),
    { name: 'AbortError' }
  )
  await fs.unlink(path.join(f.runtime.status().firmware.directory, 'sys/external/liblv2.sprx'))
  await assert.rejects(installRpcs3Content({ ...options, run: fail }), /3221226505/)
  assert.equal(
    (await fs.readdir(path.dirname(f.runtime.directory))).some((n) =>
      n.startsWith('.rpcs3-content-')
    ),
    false
  )
})
