import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import extract from '@electron-internal/extract-zip'
import { downloadArtifact } from '@electron/get'
import sourceMap from 'source-map-js'

const require = createRequire(import.meta.url)
const { coreArchive } = require('./fixtures/core-archive.cjs')
const { downloadElectronArtifactZip } = require('app-builder-lib/out/util/electronGet.js')
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
process.env.ELECTRON_GET_NO_PROGRESS = '1'

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-dependency-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('source maps reject abusive section offsets but preserve normal mappings', () => {
  const map = { version: 3, sources: ['input.js'], names: [], mappings: 'AAAA' }
  const indexed = (line, column = 0) => ({
    version: 3,
    sections: [{ offset: { line, column }, map }]
  })
  for (const line of [-1, 0.5, 10000001, Infinity]) {
    assert.throws(() => new sourceMap.SourceMapConsumer(indexed(line)), /offset/i)
  }
  assert.throws(() => new sourceMap.SourceMapConsumer(indexed(0, -1)), /offset/i)
  const consumer = new sourceMap.SourceMapConsumer(indexed(2))
  assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 1 }), {
    source: 'input.js',
    line: 1,
    column: 0,
    name: null
  })
})

test('packaging downloads preserve proxy routing, 503 retries and request deadlines', async (t) => {
  const root = await workspace(t)
  const bytes = coreArchive('fixture.txt', Buffer.from('proxy fixture'))
  let requests = 0
  const proxy = http.createServer((_req, res) => {
    requests++
    if (requests === 1) {
      res.writeHead(503)
      res.end('try again')
    } else {
      res.writeHead(200, { 'Content-Length': bytes.length })
      res.end(bytes)
    }
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => proxy.close(resolve)))
  const previousProxy = process.env.HTTP_PROXY
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`
  t.after(() => {
    if (previousProxy === undefined) delete process.env.HTTP_PROXY
    else process.env.HTTP_PROXY = previousProxy
  })
  const filename = 'electron-v42.11.15-win32-x64.zip'
  const downloaded = await downloadElectronArtifactZip({
    artifactName: 'electron',
    version: '42.11.15',
    arch: 'x64',
    platformName: 'win32',
    cacheDir: root,
    electronDownload: {
      mirrorOptions: { resolveAssetURL: async () => `http://zenith-fixture.invalid/${filename}` },
      checksums: { [filename]: createHash('sha256').update(bytes).digest('hex') },
      downloadOptions: { quiet: true, retry: { limit: 0 } }
    }
  })
  assert.deepEqual(await fs.readFile(downloaded), bytes)
  assert.equal(requests, 2, '503 is retried through the configured proxy')

  // Exercise the optional global-agent bootstrap in an isolated process: it patches http globally.
  const script = `require(${JSON.stringify(builderRequire.resolve('@electron/get'))}).initializeProxy();
    require('node:http').get('http://zenith-fixture.invalid/global-agent', r => {
      const data=[]; r.on('data', c => data.push(c));
      r.on('end', () => process.stdout.write(Buffer.concat(data).toString('base64')));
    }).on('error', e => { console.error(e); process.exitCode=1 });`
  const child = await promisify(execFile)(process.execPath, ['-e', script], {
    timeout: 5000,
    env: {
      ...process.env,
      GLOBAL_AGENT_HTTP_PROXY: process.env.HTTP_PROXY,
      GLOBAL_AGENT_NO_PROXY: ''
    }
  })
  assert.deepEqual(Buffer.from(child.stdout, 'base64'), bytes)
  assert.equal(requests, 3)

  const stalled = http.createServer(() => {})
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    stalled.closeAllConnections()
    return new Promise((resolve) => stalled.close(resolve))
  })
  await assert.rejects(
    builderRequire('@electron/get').downloadArtifact({
      artifactName: 'electron',
      version: '42.11.15',
      arch: 'x64',
      platform: 'win32',
      cacheRoot: path.join(root, 'timeout'),
      mirrorOptions: {
        resolveAssetURL: async () => `http://127.0.0.1:${stalled.address().port}/${filename}`
      },
      checksums: { [filename]: '0'.repeat(64) },
      downloadOptions: { quiet: true, timeout: { request: 50 }, retry: { limit: 0 } }
    }),
    (error) => error.code === 'ETIMEDOUT'
  )
})

test('Electron ZIP extraction preserves legitimate files and contains traversal/symlink entries', async (t) => {
  const root = await workspace(t)
  const zip = path.join(root, 'fixture.zip')
  const output = path.join(root, 'output')
  const payload = Buffer.from('synthetic archive data')
  await fs.writeFile(zip, coreArchive('nested/ordinary.txt', payload))
  await extract(zip, { dir: output })
  assert.deepEqual(await fs.readFile(path.join(output, 'nested/ordinary.txt')), payload)
  for (const name of ['../escaped.txt', '/escaped.txt']) {
    await fs.writeFile(zip, coreArchive(name, payload))
    // Unsafe entries may be skipped rather than rejecting the whole distribution.
    await extract(zip, { dir: output }).catch(() => {})
    assert.equal(await fs.stat(path.join(root, 'escaped.txt')).catch(() => null), null)
    assert.deepEqual(await fs.readFile(path.join(output, 'nested/ordinary.txt')), payload)
  }
  const link = coreArchive('unsafe-link', Buffer.from('../outside'))
  const central = link.readUInt32LE(link.length - 6)
  link.writeUInt16LE((3 << 8) | 20, central + 4)
  link.writeUInt32LE((0o120777 << 16) >>> 0, central + 38)
  await fs.writeFile(zip, link)
  await extract(zip, { dir: output }).catch(() => {})
  const target = await fs.readlink(path.join(output, 'unsafe-link')).catch(() => null)
  if (target) {
    const relative = path.relative(output, path.resolve(output, target))
    assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'symlink escaped output')
  }
  assert.equal(await fs.stat(path.join(root, 'escaped.txt')).catch(() => null), null)
})

test('electron-builder downloader retains checksum validation, progress and cache behavior', async (t) => {
  const root = await workspace(t)
  const bytes = coreArchive('fixture.txt', Buffer.from('verified local fixture'))
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests++
    res.writeHead(200, { 'Content-Length': bytes.length })
    res.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const filename = 'electron-v42.11.15-win32-x64.zip'
  let progress = 0
  const options = {
    artifactName: 'electron',
    version: '42.11.15',
    arch: 'x64',
    platformName: 'win32',
    cacheDir: root,
    electronDownload: {
      mirrorOptions: {
        resolveAssetURL: async () => `http://127.0.0.1:${server.address().port}/${filename}`
      },
      checksums: { [filename]: createHash('sha256').update(bytes).digest('hex') },
      downloadOptions: { quiet: true, getProgressCallback: () => progress++ }
    }
  }
  const downloaded = await downloadElectronArtifactZip(options)
  assert.deepEqual(await fs.readFile(downloaded), bytes)
  assert.equal(await downloadElectronArtifactZip(options), downloaded)
  assert.equal(requests, 1)
  await downloadArtifact({
    artifactName: 'electron',
    version: options.version,
    arch: 'x64',
    platform: 'win32',
    cacheRoot: path.join(root, 'progress'),
    ...options.electronDownload
  })
  assert(progress > 0)
  await assert.rejects(
    downloadElectronArtifactZip({
      ...options,
      cacheDir: path.join(root, 'invalid'),
      electronDownload: { ...options.electronDownload, checksums: { [filename]: '0'.repeat(64) } }
    }),
    /checksum/i
  )
})

test('default packaging requests do not reuse shared HTTP responses with cookies and max-stale', async (t) => {
  const root = await workspace(t)
  let requests = 0
  const bytes = coreArchive('fixture.txt', Buffer.from('public distribution fixture'))
  const server = http.createServer((_req, res) => {
    requests++
    res.writeHead(200, {
      'Content-Length': bytes.length,
      'Cache-Control': 'max-age=3600',
      'Set-Cookie': 'session=synthetic-fixture'
    })
    res.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  })
  const filename = 'electron-v42.11.15-win32-x64.zip'
  for (let index = 0; index < 2; index++) {
    const file = await downloadElectronArtifactZip({
      artifactName: 'electron',
      version: '42.11.15',
      arch: 'x64',
      platformName: 'win32',
      cacheDir: path.join(root, String(index)),
      electronDownload: {
        mirrorOptions: {
          resolveAssetURL: async () => `http://127.0.0.1:${server.address().port}/${filename}`
        },
        checksums: { [filename]: createHash('sha256').update(bytes).digest('hex') },
        downloadOptions: { quiet: true, headers: { 'cache-control': 'max-stale=999999' } }
      }
    })
    assert.deepEqual(await fs.readFile(file), bytes)
  }
  assert.equal(requests, 2, 'Independent artifact caches must fetch independent HTTP responses')
})
