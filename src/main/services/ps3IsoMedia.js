import fs from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sevenZip from '7zip-bin-full'
import { gameMediaDirectory } from './mediaPaths.js'
import { readParamSfo } from './rpcs3Library.js'

const execute = promisify(execFile)
const FILES = { boxart: 'ICON0.PNG', snap: 'PIC1.PNG' }
/** Normalize the product ID without guessing a different regional or digital release. */
export function normalizePs3TitleId(value) {
  const id = typeof value === 'string' ? value.replace(/[-\s\0]/g, '').toUpperCase() : ''
  return /^[A-Z]{4}[0-9]{5}$/.test(id) ? id : null
}
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** A fixed bounded PNG payload is the only content accepted from the untrusted disc. */
export function validPs3Png(bytes) {
  return (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(PNG) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0 &&
    bytes.readUInt32BE(16) <= 16384 &&
    bytes.readUInt32BE(20) <= 16384
  )
}
/** Read only previously extracted local media; never opens a process or network connection. */
export function cachedPs3IsoMedia(userData, game) {
  if (game.systemShort !== 'PS3' || extname(game.path || '').toLowerCase() !== '.iso') return {}
  const directory = gameMediaDirectory(userData, game.gameId)
  return Object.fromEntries(
    Object.entries(FILES).map(([kind, name]) => {
      const file = join(directory, 'embedded-' + name.toLowerCase())
      return [kind, fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? file : null]
    })
  )
}
/** Read the validated disc title ID cached during ISO extraction. */
export function cachedPs3IsoTitleId(userData, game) {
  if (game.systemShort !== 'PS3' || extname(game.path || '').toLowerCase() !== '.iso') return null
  try {
    const value = JSON.parse(
      fs.readFileSync(
        join(gameMediaDirectory(userData, game.gameId), 'embedded-title.json'),
        'utf8'
      )
    )
    const stat = fs.statSync(game.path)
    return value.path === game.path &&
      value.size === stat.size &&
      value.mtime === stat.mtimeMs &&
      /^[A-Z]{4}[0-9]{5}$/.test(value.titleId)
      ? value.titleId
      : null
  } catch {
    return null
  }
}

/**
 * Flatten only artwork and PARAM.SFO into a unique, Main-owned temporary directory.
 * Unlike stdout extraction this tolerates ISO/UDF header warnings when valid members exist.
 * Never use archive paths as destinations; validate regular files, bounds and signatures.
 */
export function createPs3IsoExtractor({ userData, executeImpl = execute, logger = console }) {
  return async (game, { force = false } = {}) => {
    if (game.systemShort !== 'PS3' || extname(game.path || '').toLowerCase() !== '.iso') return
    const stat = await fs.promises.stat(game.path).catch(() => null)
    if (!stat?.isFile()) return
    const directory = gameMediaDirectory(userData, game.gameId)
    const marker = join(directory, 'embedded-source.json')
    const source = { path: game.path, size: stat.size, mtime: stat.mtimeMs }
    const identity = JSON.stringify({ ...source, extractionVersion: 3 })
    try {
      if (
        !force &&
        (await fs.promises.readFile(marker, 'utf8')) === identity &&
        Object.values(cachedPs3IsoMedia(userData, game)).every(Boolean)
      ) {
        logger.log('[7-Zip] ICON0/PIC1 durumu: çıkartıldı (yerel önbellek) — ' + game.path)
        return
      }
    } catch {
      /* New or changed disc. */
    }
    await fs.promises.mkdir(directory, { recursive: true })
    const temporary = await fs.promises.mkdtemp(join(directory, '.iso-extract-'))
    const binary = sevenZip.path7z.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked')
    let extractionError = null
    let extractedTargets = 0
    try {
      try {
        // e flattens paths; -ssc- handles case differences and -r searches nested disc folders.
        await executeImpl(
          binary,
          [
            'e',
            '-y',
            '-aos',
            '-p',
            '-bd',
            '-ssc-',
            '-r',
            '-o' + temporary,
            '--',
            game.path,
            'PS3_GAME/ICON0.PNG',
            'PS3_GAME/PIC1.PNG',
            'PS3_GAME/PARAM.SFO',
            'ICON0.PNG',
            'PIC1.PNG',
            'PARAM.SFO',
            'PS3_DISC.SFB'
          ],
          { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }
        )
      } catch (error) {
        extractionError = error
        // Nonzero exit (including Headers Error) need not invalidate already extracted members.
      }
      const entries = await fs.promises.readdir(temporary, { withFileTypes: true })
      const readMember = async (name, limit) => {
        const entry = entries.find((item) => item.name.toUpperCase() === name && item.isFile())
        if (!entry) throw Error('Dosya bulunamadı')
        const file = join(temporary, entry.name)
        const member = await fs.promises.lstat(file)
        if (!member.isFile() || member.isSymbolicLink() || member.size > limit)
          throw Error('Geçersiz dosya veya boyut')
        return fs.promises.readFile(file)
      }
      for (const name of Object.values(FILES)) {
        const target = join(directory, 'embedded-' + name.toLowerCase())
        try {
          const bytes = await readMember(name, 20 * 1024 * 1024)
          if (!validPs3Png(bytes)) throw Error('Geçerli PNG bulunamadı')
          await fs.promises.writeFile(target + '.tmp', bytes)
          await fs.promises.rename(target + '.tmp', target)
          extractedTargets++
          logger.log('[7-Zip] ICON0/PIC1 durumu: çıkartıldı — ' + name + ' → ' + target)
        } catch (error) {
          logger.log('[7-Zip] ICON0/PIC1 durumu: bulunamadı — ' + name + ': ' + error.message)
        } finally {
          await fs.promises.rm(target + '.tmp', { force: true }).catch(() => {})
        }
      }
      let titleId = null
      try {
        const metadata = readParamSfo(await readMember('PARAM.SFO', 1024 * 1024))
        titleId = normalizePs3TitleId(metadata.TITLE_ID)
      } catch {
        /* Disc header below can still identify releases with unreadable PARAM.SFO. */
      }
      if (!titleId) {
        try {
          const header = (await readMember('PS3_DISC.SFB', 1024 * 1024)).toString('latin1')
          if (header.includes('TITLE_ID'))
            titleId = normalizePs3TitleId(header.match(/[A-Z]{4}-?[0-9]{5}/)?.[0])
        } catch {
          /* Optional disc descriptor. */
        }
      }
      // A validated SFO/SFB title ID is useful even when this disc has no artwork.
      // A filename hint or an older cached image cannot prove this extraction succeeded.
      if (titleId) extractedTargets++
      if (!extractedTargets) {
        const error = new Error('PS3 ISO: hiçbir geçerli hedef dosya çıkarılamadı', {
          cause: extractionError || undefined
        })
        error.code = 'PS3_ISO_EXTRACTION_FAILED'
        logger.log('[7-Zip] Çıkarma başarısız: ' + error.message)
        throw error
      }
      // UDF header diagnostics are harmless only after verifying useful extracted content.
      // execFile may place the warning in message, stdout or stderr depending on its exit code.
      if (
        extractionError &&
        !/\bHeaders Error\b/i.test(
          [extractionError.message, extractionError.stdout, extractionError.stderr].join('\n')
        )
      )
        logger.log('[7-Zip] Arşiv uyarısı: ' + extractionError.message)
      if (!titleId)
        titleId = normalizePs3TitleId(
          game.fileName?.match(/(?:BLUS|BLES|BLJS|BLJM|BCUS|BCES|BCJS|NPUB|NPEB)-?[0-9]{5}/i)?.[0]
        )
      if (titleId)
        await fs.promises.writeFile(
          join(directory, 'embedded-title.json'),
          JSON.stringify({ ...source, titleId })
        )
      logger.log('[7-Zip] Title ID: ' + (titleId || 'bulunamadı') + ' — ' + game.path)
      await fs.promises.writeFile(marker, identity)
    } finally {
      // Verify the resolved cleanup target belongs to this game's cache, never the ROM directory.
      const target = resolve(temporary),
        root = resolve(directory) + sep
      if (target.startsWith(root) && target.slice(root.length).startsWith('.iso-extract-'))
        await fs.promises.rm(target, { recursive: true, force: true })
      else logger.log('[7-Zip] Geçersiz geçici klasör yolu; temizleme atlandı')
    }
  }
}
