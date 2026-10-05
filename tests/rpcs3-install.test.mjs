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
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const runtime = createRpcs3Runtime({ userData: root, platform: 'win32' })
  runtime.ensureDirectories()
  const source = path.join(root, 'source')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'rpcs3.exe'), coreBinary('fixture.exe'))
  await fs.writeFile(path.join(source, 'support.txt'), 'synthetic support')
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
  assert.equal(
    await fs.readFile(path.join(f.runtime.directory, 'support.txt'), 'utf8'),
    'synthetic support'
  )
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
    'portable/dev_flash/a',
    'CON.txt',
    'x/../x',
    'firmware.PUP'
  ])
    assert.throws(() => validateRpcs3Listing('Path = ' + name + '\nSize = 1\n'), /Unsafe/)
  assert.throws(() => validateRpcs3Listing('Path = rpcs3.exe\nSize = 3000000000'), /limit/)
  assert.throws(
    () => validateRpcs3Listing('Path = rpcs3.exe\nSize = 1\nSymbolic Link = elsewhere'),
    /Unsafe/
  )
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
