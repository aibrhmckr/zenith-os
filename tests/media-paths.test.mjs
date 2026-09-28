import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gameMediaDirectory, mediaRoot } from '../src/main/services/mediaPaths.js'
import { createMediaDownloader } from '../src/main/services/mediaScraper.js'
import { createGuideService } from '../src/main/services/guideService.js'
import { createScraper } from '../src/main/services/scraper.js'

test('all download services require an explicit absolute userData root', () => {
  for (const userData of [undefined, '', '.', 'media']) {
    assert.throws(() => mediaRoot(userData), /absolute userData/)
    for (const factory of [createMediaDownloader, createGuideService, createScraper]) {
      assert.throws(() => factory({ userData }), /absolute userData/)
    }
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-paths-'))
  assert.equal(
    gameMediaDirectory(userData, 'ps2-example'),
    path.join(userData, 'media', 'ps2-example')
  )
  for (const gameId of ['../roms', '..\\roms', '/outside', 'C:\\outside', '.', '', null]) {
    assert.throws(() => gameMediaDirectory(userData, gameId), /Invalid media game ID/)
  }
})

test('a forged mediaDirectory cannot redirect music/video writes outside userData', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-storage-'))
  const userData = path.join(root, 'profile')
  const outside = path.join(root, 'project', 'media', 'forged')
  const bytes = {
    music: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]),
    video: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
  }
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    const music =
      parsed.searchParams.get('q')?.includes('audio') ||
      parsed.searchParams.get('q')?.includes('vgm_ost')
    if (parsed.pathname === '/advancedsearch.php')
      return Response.json({
        response: {
          docs: [
            {
              identifier: music ? 'alpha-music' : 'alpha-video',
              title: music ? 'Alpha Soundtrack' : 'Alpha Preview'
            }
          ]
        }
      })
    if (parsed.pathname === '/metadata/alpha-music')
      return Response.json({
        files: [{ name: 'title.mp3', size: bytes.music.length, length: '30' }]
      })
    if (parsed.pathname === '/metadata/alpha-video')
      return Response.json({
        files: [{ name: 'clip.mp4', size: bytes.video.length, length: '30' }]
      })
    return new Response(parsed.pathname.endsWith('.mp3') ? bytes.music : bytes.video)
  }
  const download = createMediaDownloader({ userData, fetchImpl })
  const game = {
    gameId: 'ps2-alpha-test',
    title: 'Alpha',
    mediaDirectory: outside,
    media: { music: path.join(outside, 'music.mp3') }
  }
  const result = await download(game)
  for (const [kind, name] of [
    ['music', 'theme.mp3'],
    ['video', 'preview.mp4']
  ]) {
    assert.equal(result[kind], path.join(userData, 'media', game.gameId, name))
    assert.deepEqual(fs.readFileSync(result[kind]), bytes[kind])
  }
  assert.equal(fs.existsSync(path.join(root, 'project')), false)
  assert.deepEqual(await download({ ...game, gameId: '../escape' }), { music: null, video: null })
})

test('Git ignores runtime media at any depth and case while keeping source/test files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-ignore-'))
  execFileSync('git', ['init', '--quiet', root])
  fs.copyFileSync(
    fileURLToPath(new URL('../.gitignore', import.meta.url)),
    path.join(root, '.gitignore')
  )
  const files = [
    'media/test.txt',
    'nested/MEDIA/test.txt',
    'deep/games/game.md',
    'deep/roms/raw',
    'a/saves/raw',
    'a/logs/raw',
    'videos/test',
    'music/test',
    'manuals/test',
    ...[
      'DLL',
      'dLl',
      'EXE',
      'PART',
      'MP4',
      'mKv',
      'WEBM',
      'MP3',
      'ogg',
      'WAV',
      'PDF',
      'ISO',
      'bin',
      'chd',
      'nds',
      'gba',
      'gb',
      'nes',
      'gcm',
      'gen',
      'JPG',
      'PNG',
      'svg',
      'sav',
      'state1'
    ].flatMap((ext) => [`file.${ext}`, `nested/game.${ext}`])
  ]
  const ignored = execFileSync(
    'git',
    ['-c', 'core.ignorecase=false', 'check-ignore', '--no-index', '--stdin'],
    { cwd: root, input: files.join('\n') + '\n', encoding: 'utf8' }
  )
    .trim()
    .split(/\r?\n/)
  assert.deepEqual(ignored, files)
  for (const source of [
    'README.md',
    'src/main/services/mediaPaths.js',
    'tests/media-paths.test.mjs',
    'src/renderer/src/assets/sounds/navigate.wav',
    'src/renderer/src/assets/sounds/toggle.wav',
    'src/renderer/src/assets/sounds/launch.wav'
  ]) {
    assert.throws(
      () =>
        execFileSync('git', ['check-ignore', '--no-index', source], { cwd: root, stdio: 'pipe' }),
      { status: 1 }
    )
  }
})
