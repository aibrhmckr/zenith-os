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
    'STATE'
  ]) {
    const file = 'fixture.' + extension
    fs.writeFileSync(path.join(root, file), 'synthetic fixture')
    git('add', '-f', file)
    assert.equal(check().status, 1, 'Forced runtime file must be rejected: ' + extension)
    git('rm', '--cached', '--quiet', file)
  }
  fs.writeFileSync(path.join(root, 'renamed.txt'), 'MZsynthetic signature')
  git('add', 'renamed.txt')
  assert.equal(check().status, 1, 'Executable signature with innocent suffix is rejected')
})
