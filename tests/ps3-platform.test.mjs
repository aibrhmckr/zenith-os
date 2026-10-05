import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  CONSOLE_EXTENSIONS,
  GAME_FILE_FILTERS,
  PS3_GAME_LAYOUTS,
  detectConsole,
  isPS3BootPath
} from '../src/shared/consoles.js'
import { createGameImporter } from '../src/main/services/gameImporter.js'
import { createLibraryStore } from '../src/main/services/libraryStore.js'

test('PS3 registry/picker includes ISO, PKG and BIN without changing shared extension defaults', () => {
  assert.deepEqual(CONSOLE_EXTENSIONS.PS3, ['.iso', '.pkg', '.bin'])
  for (const ext of CONSOLE_EXTENSIONS.PS3)
    assert(GAME_FILE_FILTERS[0].extensions.includes(ext.slice(1)))
  assert.equal(
    new Set(GAME_FILE_FILTERS[0].extensions).size,
    GAME_FILE_FILTERS[0].extensions.length
  )
  assert.deepEqual(GAME_FILE_FILTERS.at(-1).extensions, ['*'])
  for (const [file, expected] of [
    ['Example.iso', 'PS2'],
    ['Portable (PSP).iso', 'PSP'],
    ['Vice City Stories.iso', 'PSP'],
    ['Example (PS3).ISO', 'PS3'],
    ['C:\\Games\\PS3\\Example.iso', 'PS3'],
    ['/games/PlayStation 3/Example.iso', 'PS3'],
    ['Example.pkg', 'PS3'],
    ['EXAMPLE.PKG', 'PS3'],
    ['dump.bin', 'Unassigned'],
    ['PS3/dump.bin', 'Unassigned'],
    ['EBOOT.BIN', 'Unassigned'],
    ['PSP_GAME/SYSDIR/EBOOT.BIN', 'Unassigned'],
    ['PS30.iso', 'PS2'],
    ['Example.nds', 'NDS'],
    ['PS3UPDAT.PUP', undefined]
  ])
    assert.equal(detectConsole(file), expected, file)
})

test('PS3 boot layouts are explicit and platform-independent, not every BIN', () => {
  assert.equal(PS3_GAME_LAYOUTS.disc, 'PS3_GAME/USRDIR/EBOOT.BIN')
  assert.equal(PS3_GAME_LAYOUTS.installed, 'USRDIR/EBOOT.BIN')
  for (const file of [
    'PS3_GAME/USRDIR/EBOOT.BIN',
    'Title/USRDIR/EBOOT.BIN',
    'C:\\Title\\PS3_GAME\\USRDIR\\EBOOT.BIN',
    '/games/title/usrdir/eboot.bin'
  ]) {
    assert(isPS3BootPath(file), file)
    assert.equal(detectConsole(file), 'PS3')
  }
  for (const file of [
    'EBOOT.BIN',
    'USRDIR/OTHER.BIN',
    'USRDIR/EBOOT.BIN.bak',
    'MYUSRDIR/EBOOT.BIN',
    null
  ])
    assert.equal(isPS3BootPath(file), false)
})

test('central import preserves PS3 ISO path hints and refuses incomplete EBOOT copies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-ps3-platform-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const source = path.join(root, 'PS3'),
    games = path.join(root, 'games')
  fs.mkdirSync(source)
  const iso = path.join(source, 'Example.iso'),
    pkg = path.join(source, 'Package.PKG')
  fs.writeFileSync(iso, 'synthetic fixture')
  fs.writeFileSync(pkg, 'synthetic fixture')
  const imported = await createGameImporter(games)([iso, pkg])
  assert.equal(path.basename(imported[0]), 'Example (PS3).iso')
  const library = createLibraryStore(root)
  library.add(imported)
  assert.deepEqual(
    createLibraryStore(root)
      .list()
      .map((game) => game.systemShort),
    ['PS3', 'PS3']
  )
  assert(fs.existsSync(iso))
  const boot = path.join(source, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN')
  fs.mkdirSync(path.dirname(boot), { recursive: true })
  fs.writeFileSync(boot, 'synthetic fixture')
  assert.equal(library.add([boot]), 1)
  assert.equal(library.list().at(-1).systemShort, 'PS3')
  await assert.rejects(createGameImporter(games)([boot]), /keep the complete game folder/)
  assert.equal(fs.existsSync(path.join(games, 'EBOOT.BIN')), false)
})

test('PS3 runtime and firmware/license formats stay ignored at any depth/case', () => {
  const files = [
    'test.pkg',
    'nested/TEST.PKG',
    'firmware.PUP',
    'key.RAP',
    'key.rif',
    'boot.SELF',
    'module.SPRX',
    'PS3_GAME/PARAM.SFO',
    'dev_flash/version.txt',
    'dev_hdd0/game/info.txt',
    'emulators/rpcs3/rpcs3'
  ]
  const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
    input: files.join('\n') + '\n',
    encoding: 'utf8'
  })
    .trim()
    .split(/\r?\n/)
  assert.deepEqual(ignored, files)
})
