import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sevenZip from '7zip-bin'

const exec = promisify(execFile)
const STABLE = 'https://buildbot.libretro.com/stable/'
const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export function latestStable(html) {
  const versions = [...html.matchAll(/href=["'](?:\/stable\/)?(\d+\.\d+\.\d+)\/["']/g)]
    .map((match) => match[1])
    .sort((a, b) => {
      const left = a.split('.').map(Number),
        right = b.split('.').map(Number)
      return right[0] - left[0] || right[1] - left[1] || right[2] - left[2]
    })
  if (!versions.length) throw Error('Official stable release index contains no versions.')
  return versions[0]
}

// Reject archive paths escaping the staging directory before asking 7-Zip to extract.
export function validateListing(listing) {
  const entries = listing.split(/\r?\n/).filter((line) => line.startsWith('Path = '))
  if (!entries.length) throw Error('Archive contains no files.')
  for (const line of entries) {
    const name = line.slice(7).replaceAll('\\', '/')
    if (name.startsWith('/') || name.includes(':') || name.split('/').includes('..')) {
      throw Error('Unsafe archive path: ' + name)
    }
  }
  if (/^(Symbolic Link|Hard Link) = .+/m.test(listing))
    throw Error('Archive links are not allowed.')
}

export async function downloadArchive(
  url,
  destination,
  { fetchImpl = fetch, log = console.log, maxBytes = 1024 * 1024 * 1024 } = {}
) {
  const signal = AbortSignal.timeout(10 * 60 * 1000)
  const response = await fetchImpl(url, { signal, redirect: 'error' })
  if (!response.ok || !response.body) throw Error(`Download failed: HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  if (total > maxBytes) throw Error('Archive exceeds the 1 GiB download limit.')
  let received = 0,
    last = 0
  const progress = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length
      if (received > maxBytes) return done(Error('Archive exceeds the download limit.'))
      if (Date.now() - last > 1000) {
        log(
          `RetroArch: ${(received / 1048576).toFixed(1)} MiB${total ? ' / ' + (total / 1048576).toFixed(1) + ' MiB' : ''}`
        )
        last = Date.now()
      }
      done(null, chunk)
    }
  })
  try {
    await pipeline(response.body, progress, createWriteStream(destination, { flags: 'wx' }), {
      signal
    })
    if (!received || (total && total !== received)) throw Error('Incomplete archive download.')
  } catch (error) {
    await fs.rm(destination, { force: true })
    throw error
  }
}

export async function setupEmulators({
  root = projectRoot,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  log = console.log
} = {}) {
  if (!['win32', 'linux'].includes(platform) || arch !== 'x64') {
    throw Error('Bootstrap supports Windows/Linux x64 only.')
  }
  const destination = path.join(root, 'emulators', 'retroarch')
  await fs.mkdir(path.join(destination, 'cores'), { recursive: true })
  if (platform === 'linux') {
    log(
      'Linux detected. Place a native x64 RetroArch installation (including runtime dependencies) in emulators/retroarch/, with executable emulators/retroarch/retroarch (chmod +x).'
    )
    log(
      'Official installation options: https://docs.libretro.com/guides/install-gnu/ . Windows binaries are never downloaded on Linux.'
    )
    return { installed: false, platform }
  }
  try {
    await fs.access(path.join(destination, 'retroarch.exe'))
    log('RetroArch already exists; preserving your installation. No files were replaced.')
    return { installed: false, existing: true }
  } catch {
    /* first installation */
  }
  const index = await fetchImpl(STABLE, { signal: AbortSignal.timeout(15000), redirect: 'error' })
  if (!index.ok) throw Error(`Stable release lookup failed: HTTP ${index.status}`)
  const version = latestStable(await index.text())
  const url = `${STABLE}${version}/windows/x86_64/RetroArch.7z`
  log(`Installing stable RetroArch ${version}: ${url}`)
  const staging = await fs.mkdtemp(path.join(root, 'emulators', '.retroarch-setup-'))
  try {
    const archive = path.join(staging, 'RetroArch.7z')
    await downloadArchive(url, archive, { fetchImpl, log })
    const { stdout } = await exec(sevenZip.path7za, ['l', '-slt', '-ba', archive], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    })
    validateListing(stdout)
    const extracted = path.join(staging, 'extracted')
    await exec(sevenZip.path7za, ['x', archive, '-o' + extracted, '-y'], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    })
    const files = await fs.readdir(extracted, { recursive: true })
    const executable = files.find((file) => path.basename(file).toLowerCase() === 'retroarch.exe')
    if (!executable) throw Error('Official archive did not contain retroarch.exe.')
    const source = path.dirname(path.join(extracted, executable))
    // Copy supporting files first; executable is the completion marker. Never overwrite user files.
    await fs.cp(source, destination, {
      recursive: true,
      force: false,
      filter: (file) => file !== path.join(source, 'retroarch.exe')
    })
    await fs.copyFile(
      path.join(source, 'retroarch.exe'),
      path.join(destination, 'retroarch.exe'),
      1
    )
    await fs.writeFile(
      path.join(destination, 'zenith-bootstrap.json'),
      JSON.stringify({ version, url, platform, arch }, null, 2)
    )
    log('RetroArch installed in ' + destination)
    return { installed: true, version }
  } finally {
    // mkdtemp returned this path under the explicit project emulator directory.
    await fs.rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  setupEmulators().catch((error) => {
    console.error('RetroArch setup failed: ' + error.message)
    process.exitCode = 1
  })
}
