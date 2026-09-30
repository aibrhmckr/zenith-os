import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedBundledRetroArch } from '../src/main/services/bundledRuntime.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-locked-runtime-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'resources', 'emulators', 'retroarch')
  const destination = path.join(root, 'profile', 'emulators', 'retroarch')
  await fs.mkdir(path.join(source, 'autoconfig'), { recursive: true })
  await fs.mkdir(destination, { recursive: true })
  await fs.writeFile(path.join(source, 'retroarch.exe'), 'MZsynthetic')
  await fs.writeFile(path.join(source, 'autoconfig', '8BitDo.cfg'), 'controller config')
  await fs.writeFile(path.join(source, 'autoconfig', 'other.cfg'), 'other controller')
  return {
    source,
    destination,
    options: {
      resourcesPath: path.join(root, 'resources'),
      retroarchDir: destination,
      platform: 'win32'
    }
  }
}

for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
  test(`locked config (${code}) does not stop seeding; next pass retries it without touching existing files`, async (t) => {
    const { source, destination, options } = await fixture(t)
    const messages = []
    await seedBundledRetroArch({
      ...options,
      log: (message) => messages.push(message),
      fsImpl: {
        ...fs,
        copyFile: async (from, to, flags) => {
          assert(flags & constants.COPYFILE_EXCL)
          if (from.endsWith('8BitDo.cfg')) throw Object.assign(Error('locked'), { code })
          return fs.copyFile(from, to, flags)
        }
      }
    })
    assert.equal(messages.length, 1)
    assert(messages[0].includes(code))
    await fs.access(path.join(destination, 'retroarch.exe'))
    await fs.access(path.join(destination, 'autoconfig', 'other.cfg'))
    await assert.rejects(fs.access(path.join(destination, 'autoconfig', '8BitDo.cfg')))
    const existing = path.join(destination, 'autoconfig', 'other.cfg')
    await fs.writeFile(existing, 'user customized config')
    const before = await fs.stat(existing)
    const copies = []
    assert.equal(
      await seedBundledRetroArch({
        ...options,
        fsImpl: {
          ...fs,
          copyFile: async (...args) => {
            copies.push(args[0])
            return fs.copyFile(...args)
          }
        }
      }),
      true
    )
    assert.deepEqual(copies, [path.join(source, 'autoconfig', '8BitDo.cfg')])
    assert.equal(await fs.readFile(existing, 'utf8'), 'user customized config')
    assert.equal((await fs.stat(existing)).mtimeMs, before.mtimeMs)
    assert.equal(await seedBundledRetroArch(options), false)
  })
}

test('zero-byte interrupted files are repaired, and locked config publication leaves no partial files', async (t) => {
  const { destination, options } = await fixture(t)
  await fs.writeFile(path.join(destination, 'retroarch.exe'), '')
  await seedBundledRetroArch({
    ...options,
    log: () => {},
    fsImpl: {
      ...fs,
      rename: async (from, to) => {
        if (to.endsWith('8BitDo.cfg'))
          throw Object.assign(Error('locked rename'), { code: 'EBUSY' })
        return fs.rename(from, to)
      }
    }
  })
  assert.equal(await fs.readFile(path.join(destination, 'retroarch.exe'), 'utf8'), 'MZsynthetic')
  assert.deepEqual(await fs.readdir(path.join(destination, 'autoconfig')), ['other.cfg'])
})

test('a critical DLL error is reported instead of silently marking the runtime ready', async (t) => {
  const { source, destination, options } = await fixture(t)
  await fs.writeFile(path.join(source, 'dependency.dll'), 'synthetic dependency')
  await assert.rejects(
    seedBundledRetroArch({
      ...options,
      fsImpl: {
        ...fs,
        copyFile: async (from, to, flags) => {
          if (from.endsWith('.dll'))
            throw Object.assign(Error('locked dependency'), { code: 'EBUSY' })
          return fs.copyFile(from, to, flags)
        }
      }
    }),
    /locked dependency/
  )
  await assert.rejects(fs.access(path.join(destination, 'retroarch.exe')))
})
