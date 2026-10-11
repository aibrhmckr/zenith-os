import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

test('commit guard rejects forced ROMs and renamed executables, preserving ordinary source', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-distribution-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root })
  git('init', '--quiet')
  fs.copyFileSync(
    fileURLToPath(new URL('../.gitignore', import.meta.url)),
    path.join(root, '.gitignore')
  )
  fs.writeFileSync(path.join(root, 'source.js'), 'export const ok = true\n')
  git('add', 'source.js')
  const check = () =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../scripts/check-distribution.mjs', import.meta.url))],
      { cwd: root, encoding: 'utf8' }
    )
  assert.equal(check().status, 0)
  for (const folder of ['emulators/retroarch', 'emulators/retroarch/cores']) {
    fs.mkdirSync(path.join(root, folder), { recursive: true })
    fs.writeFileSync(path.join(root, folder, '.gitkeep'), '')
    git('add', folder + '/.gitkeep')
  }
  assert.equal(check().status, 0, 'Empty emulator skeleton is committable')
  fs.writeFileSync(path.join(root, 'emulators/retroarch/.gitkeep'), 'MZnot an empty placeholder')
  git('add', 'emulators/retroarch/.gitkeep')
  assert.equal(check().status, 1, 'Placeholder exception cannot smuggle content')
  fs.writeFileSync(path.join(root, 'emulators/retroarch/.gitkeep'), '')
  git('add', 'emulators/retroarch/.gitkeep')
  for (const extension of [
    'A26',
    'A78',
    'LNX',
    'ATX',
    'ELF',
    'D64',
    'HDF',
    'PRX',
    'VPK',
    'AXF',
    'J64',
    'XFD',
    'STATE',
    'PuP',
    'PkG',
    'RaP',
    'RiF',
    'SeLf',
    'SpRx'
  ]) {
    const file = 'fixture.' + extension
    fs.writeFileSync(path.join(root, file), 'synthetic fixture')
    git('add', '-f', file)
    assert.equal(check().status, 1, 'Forced runtime file must be rejected: ' + extension)
    git('rm', '--cached', '--quiet', file)
  }
  for (const bytes of [
    Buffer.from('SCEUF'),
    Buffer.from([127, 80, 75, 71]),
    Buffer.from([83, 67, 69, 0])
  ]) {
    fs.writeFileSync(path.join(root, 'renamed-firmware.txt'), bytes)
    git('add', 'renamed-firmware.txt')
    assert.equal(check().status, 1, 'Renamed firmware/package signature is rejected')
    git('rm', '--cached', '--quiet', 'renamed-firmware.txt')
  }
  fs.writeFileSync(path.join(root, 'renamed.txt'), 'MZsynthetic signature')
  git('add', 'renamed.txt')
  assert.equal(check().status, 1, 'Executable signature with innocent suffix is rejected')
})

test('packaging excludes PS3 inputs and runtimes while retaining extractor notices', async () => {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const yaml = require('js-yaml')
  const { minimatch } = require('minimatch')
  const config = yaml.load(
    fs.readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  )
  const filters = config.extraResources.find((entry) => entry.to === 'emulators/retroarch').filter
  const denied = (rules, name) =>
    rules.some((rule) => rule.startsWith('!') && minimatch(name, rule.slice(1), { dot: true }))
  for (const file of [
    'PS3UPDAT.PuP',
    'update.PkG',
    'license.RaP',
    'license.RiF',
    'boot.SeLf',
    'module.SpRx',
    'rpcs3.exe',
    'dev_flash/sys/module',
    'dev_hdd0/game/a',
    'PS3_GAME/USRDIR/EBOOT.BIN'
  ]) {
    assert(denied(config.files, 'out/' + file), 'App payload must exclude ' + file)
    assert(denied(filters, file), 'RetroArch resources must exclude ' + file)
  }
  assert(config.files.includes('resources/licenses/**'))
  assert(config.asarUnpack.includes('node_modules/7zip-bin/**'))
  assert(config.asarUnpack.includes('node_modules/7zip-bin-full/**'))
  // Exercise builder's ordered filter implementation: utility DLL must survive without
  // weakening ROM/core exclusions elsewhere in the application or RetroArch resources.
  const { createFilter } = require('app-builder-lib/out/util/filter.js')
  const { Minimatch } = require('minimatch')
  const root = path.resolve('.')
  const filter = createFilter(
    root,
    config.files.map((pattern) => new Minimatch(pattern, { dot: true }))
  )
  const stat = { isDirectory: () => false }
  assert(filter(path.join(root, 'node_modules/7zip-bin-full/win/x64/7z.dll'), stat))
  assert(!filter(path.join(root, 'out/pcsx2_libretro.dll'), stat))
  assert(!filter(path.join(root, 'out/PS3UPDAT.PUP'), stat))
  assert(!config.extraResources.some((entry) => /rpcs3/i.test(entry.from)))
})
