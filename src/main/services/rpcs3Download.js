import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, dirname, resolve, relative, sep, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sevenZip from '7zip-bin'

const exec = promisify(execFile)
export const RPCS3_RELEASE_API =
  'https://api.github.com/repos/RPCS3/rpcs3-binaries-win/releases/latest'
const MAX_ARCHIVE = 200 * 1024 * 1024
const MAX_EXPANDED = 2 * 1024 * 1024 * 1024
const releasePrefix = 'https://github.com/RPCS3/rpcs3-binaries-win/releases/download/'

/** Fixed official repository assets only; renderer cannot select arbitrary download URLs. */
export function selectRpcs3Asset(release) {
  if (release.draft || release.prerelease) throw Error('No stable RPCS3 release is available.')
  const assets =
    release.assets?.filter((a) => /^rpcs3-[a-z0-9.+_-]+_win64_msvc\.(7z|zip)$/i.test(a.name)) || []
  if (assets.length !== 1) throw Error('Official Windows x64 RPCS3 archive not found.')
  const asset = assets[0]
  const url = new URL(asset.browser_download_url)
  if (
    !url.href.startsWith(releasePrefix) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    decodeURIComponent(url.pathname.split('/').at(-1)) !== asset.name ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > MAX_ARCHIVE
  )
    throw Error('Invalid RPCS3 release asset.')
  // Fail closed when upstream cannot supply a digest; CRC alone is not download authenticity.
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || ''))
    throw Error('Official release has no SHA-256 digest. Try again later.')
  return { ...asset, sha256: asset.digest.slice(7).toLowerCase() }
}

/** Bound and validate redirects before issuing the next request, including GitHub's asset CDN. */
async function request(url, fetchImpl, signal) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    const next = new URL(url)
    if (
      next.protocol !== 'https:' ||
      next.username ||
      next.password ||
      next.port ||
      ![
        'api.github.com',
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com'
      ].includes(next.hostname)
    )
      throw Error('Untrusted RPCS3 download redirect.')
    const response = await fetchImpl(next.href, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'Zenith-OS', Accept: 'application/vnd.github+json' }
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw Error('Missing download redirect.')
      url = new URL(location, next).href
      continue
    }
    if (!response.ok || !response.body)
      throw Error(`RPCS3 download failed (HTTP ${response.status}).`)
    return response
  }
  throw Error('Too many RPCS3 download redirects.')
}

/** Validate paths/links first, then select binary files outside user-owned profile trees. */
export function validateRpcs3Listing(text) {
  const entries = text
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map((block) =>
      Object.fromEntries(
        block
          .split(/\r?\n/)
          .filter((line) => line.includes(' = '))
          .map((line) => {
            const p = line.indexOf(' = ')
            return [line.slice(0, p), line.slice(p + 3)]
          })
      )
    )
  let total = 0
  const names = new Set()
  const binaries = []
  if (!entries.length || entries.length > 20000) throw Error('Invalid archive entry count.')
  for (const entry of entries) {
    const name = (entry.Path || '').replaceAll('\\', '/')
    const parts = name.split('/')
    if (
      !name ||
      name.startsWith('/') ||
      name.includes(':') ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$|[<>"|?*]/.test(part) ||
          [...part].some((c) => c.charCodeAt(0) < 32) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      ) ||
      entry['Symbolic Link'] ||
      entry['Hard Link'] ||
      /l/.test(entry.Attributes || '') ||
      names.has(name.toLowerCase())
    )
      throw Error('Unsafe RPCS3 archive entry: ' + name)
    names.add(name.toLowerCase())
    const size = Number(entry.Size || 0)
    if (!Number.isSafeInteger(size) || size < 0 || (total += size) > MAX_EXPANDED)
      throw Error('RPCS3 extraction limit exceeded.')
    // Official releases can include config templates and empty VFS directories. These
    // are harmless metadata, but must never be extracted over a user's portable profile.
    if (
      entry.Folder === '+' ||
      /^D/.test(entry.Attributes || '') ||
      parts.some((part) =>
        /^(?:portable|dev_flash[23]?|dev_hdd[01]|PS3_GAME|firmware|bios|saves|savedata|states|config|input_configs|cache|logs|screenshots)(?:\.|$)/i.test(
          part
        )
      ) ||
      !/\.(exe|dll)$/i.test(name)
    )
      continue
    binaries.push({ ...entry, Path: name })
  }
  if (!binaries.some((entry) => entry.Path.toLowerCase() === 'rpcs3.exe'))
    throw Error('Archive must contain rpcs3.exe at its root.')
  return binaries
}

/** Reject junctions/symlinks in an owned path before writes or cleanup. */
export async function assertOwnedPath(root, target) {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '..' || rel.startsWith('..' + sep) || resolve(root, rel) !== resolve(target))
    throw Error('Path escapes runtime.')
  let current = resolve(root)
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part)
    const stat = await fs.lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isSymbolicLink()) throw Error('Runtime links are not allowed: ' + current)
  }
}

/** Strip only the newly verified download's NTFS attachment stream; never change OS policy. */
export async function clearDownloadedZone(file, unlink = fs.unlink) {
  try {
    await unlink(file + ':Zone.Identifier')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/** Download, verify, extract and publish a complete runtime; caller owns consent and serialization. */
export async function downloadRpcs3({
  runtime,
  signal,
  progress = () => {},
  fetchImpl = fetch,
  execImpl = exec,
  platform = process.platform,
  arch = process.arch,
  update = false
}) {
  if (platform !== 'win32' || arch !== 'x64')
    throw Error('Automatic RPCS3 download supports Windows x64 only.')
  if (!update && runtime.status().executableReady)
    return { success: true, existing: true, status: runtime.status() }
  const parent = dirname(runtime.directory)
  await assertOwnedPath(parent, runtime.directory)
  await fs.mkdir(parent, { recursive: true })
  const stage = await fs.mkdtemp(join(parent, '.rpcs3-download-'))
  const installed = []
  let rollbackFailed = false
  const combined = AbortSignal.any([
    signal || new AbortController().signal,
    AbortSignal.timeout(10 * 60 * 1000)
  ])
  try {
    if (!update) progress({ phase: 'lookup' })
    const metadata = await request(
      RPCS3_RELEASE_API,
      fetchImpl,
      AbortSignal.any([combined, AbortSignal.timeout(15000)])
    )
    let chunks = [],
      size = 0
    for await (const chunk of metadata.body) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) throw Error('Release metadata too large.')
      chunks.push(Buffer.from(chunk))
    }
    const release = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const asset = selectRpcs3Asset(release)
    const installedVersion = release.tag_name || asset.name
    const versionFile = join(runtime.directory, 'zenith-release.json')
    await assertOwnedPath(parent, versionFile)
    if (update && runtime.status().executableReady) {
      try {
        const previous = JSON.parse(await fs.readFile(versionFile, 'utf8'))
        const executable = await fs.stat(join(runtime.directory, 'rpcs3.exe'))
        if (
          previous.installedVersion === installedVersion &&
          previous.assetSha256 === asset.sha256 &&
          previous.executableSize === executable.size &&
          previous.executableMtimeMs === executable.mtimeMs
        )
          return {
            success: true,
            upToDate: true,
            version: installedVersion,
            status: runtime.status()
          }
      } catch {
        // Older/manual installations and damaged metadata get one verified install to establish provenance.
      }
    }
    const archive = join(stage, basename(asset.name))
    const response = await request(asset.browser_download_url, fetchImpl, combined)
    const hash = createHash('sha256')
    let received = 0,
      last = 0
    await pipeline(
      response.body,
      new Transform({
        transform(chunk, _encoding, done) {
          received += chunk.length
          if (received > asset.size || received > MAX_ARCHIVE)
            return done(Error('RPCS3 archive exceeds size limit.'))
          hash.update(chunk)
          if (Date.now() - last > 250) {
            progress({ phase: 'downloading', received, total: asset.size })
            last = Date.now()
          }
          done(null, chunk)
        }
      }),
      createWriteStream(archive, { flags: 'wx' }),
      { signal: combined }
    )
    if (received !== asset.size || hash.digest('hex') !== asset.sha256)
      throw Error('RPCS3 archive SHA-256/size verification failed.')
    await clearDownloadedZone(archive)
    const seven = sevenZip.path7za.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked')
    const opts = {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      signal: combined
    }
    progress({ phase: 'verifying' })
    const { stdout } = await execImpl(seven, ['l', '-slt', '-ba', archive], opts)
    const files = validateRpcs3Listing(stdout)
    await execImpl(seven, ['t', archive, '-y'], opts)
    const extracted = join(stage, 'extracted')
    // An exact UTF-8 include list keeps skipped files out of staging as well as the
    // live runtime; -spd disables wildcard interpretation of member names.
    const includeList = join(stage, 'binaries.txt')
    await fs.writeFile(includeList, files.map((entry) => entry.Path).join('\n'), 'utf8')
    progress({ phase: 'extracting' })
    await execImpl(
      seven,
      ['x', archive, '-o' + extracted, '-y', '-spd', '-r-', '-scsUTF-8', '-i@' + includeList],
      opts
    )
    // Validate extracted types, sizes and x64 PE before any existing runtime files are touched.
    for (const e of files) {
      const file = join(extracted, e.Path)
      await assertOwnedPath(extracted, file)
      const st = await fs.lstat(file)
      if (!st.isFile() || st.nlink !== 1 || st.size !== Number(e.Size))
        throw Error('Extracted RPCS3 file mismatch.')
      await clearDownloadedZone(file)
    }
    const header = Buffer.alloc(4096),
      fd = await fs.open(join(extracted, 'rpcs3.exe'), 'r')
    try {
      await fd.read(header, 0, header.length, 0)
    } finally {
      await fd.close()
    }
    const pe = header.readUInt32LE(60)
    if (
      header.toString('ascii', 0, 2) !== 'MZ' ||
      pe < 64 ||
      pe + 6 > header.length ||
      header.readUInt32LE(pe) !== 0x4550 ||
      header.readUInt16LE(pe + 4) !== 0x8664
    )
      throw Error('RPCS3 executable is not Windows x64.')
    progress({ phase: 'publishing' })
    // Executable is published last. Preserve portable data and roll back replaced binaries on failure.
    files.sort(
      (a, b) =>
        Number(a.Path.toLowerCase() === 'rpcs3.exe') - Number(b.Path.toLowerCase() === 'rpcs3.exe')
    )
    for (const e of files) {
      combined.throwIfAborted()
      const target = join(runtime.directory, e.Path),
        backup = join(stage, 'backup', e.Path)
      await assertOwnedPath(parent, target)
      await fs.mkdir(dirname(target), { recursive: true })
      const record = { target, backup, replaced: false, published: false }
      installed.push(record)
      const old = await fs.lstat(target).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (old) {
        if (!old.isFile()) throw Error('Runtime destination is not a regular file.')
        await fs.mkdir(dirname(backup), { recursive: true })
        await fs.rename(target, backup)
        record.replaced = true
      }
      await fs.rename(join(extracted, e.Path), target)
      record.published = true
    }
    const status = runtime.status()
    if (!status.executableReady) throw Error('Installed RPCS3 executable failed verification.')
    // Persist only after successful publication; failed downloads/rollback never advance the release tag.
    const executable = await fs.stat(join(runtime.directory, 'rpcs3.exe'))
    const versionTemporary = join(stage, 'zenith-release.json')
    await fs.writeFile(
      versionTemporary,
      JSON.stringify({
        installedVersion,
        assetSha256: asset.sha256,
        executableSize: executable.size,
        executableMtimeMs: executable.mtimeMs
      })
    )
    await fs.rename(versionTemporary, versionFile)
    progress({ phase: 'complete' })
    return { success: true, status, version: installedVersion }
  } catch (error) {
    for (const item of installed.reverse()) {
      try {
        await assertOwnedPath(parent, item.target)
        if (item.published) await fs.unlink(item.target)
        if (item.replaced) await fs.rename(item.backup, item.target)
      } catch {
        rollbackFailed = true
      }
    }
    if (rollbackFailed)
      throw Error(`${error.message} Runtime recovery files preserved at ${stage}.`)
    throw error
  } finally {
    if (!rollbackFailed) {
      await assertOwnedPath(parent, stage)
      // Windows may briefly keep replaced binaries open during the final directory cleanup.
      await fs.rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
}
