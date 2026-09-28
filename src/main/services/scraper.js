import fs from 'node:fs'
import { join, parse, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { createMediaDownloader } from './mediaScraper.js'
import { mediaRoot as getMediaRoot, gameMediaDirectory } from './mediaPaths.js'

const CDN = 'https://thumbnails.libretro.com/'
const SYSTEMS = {
  PS2: 'Sony - PlayStation 2',
  PS1: 'Sony - PlayStation',
  PSP: 'Sony - PlayStation Portable',
  NDS: 'Nintendo - Nintendo DS',
  GBA: 'Nintendo - Game Boy Advance',
  GBC: 'Nintendo - Game Boy Color',
  GameCube: 'Nintendo - GameCube',
  Wii: 'Nintendo - Wii',
  N64: 'Nintendo - Nintendo 64',
  SNES: 'Nintendo - Super Nintendo Entertainment System',
  NES: 'Nintendo - Nintendo Entertainment System',
  '3DS': 'Nintendo - Nintendo 3DS',
  Genesis: 'Sega - Mega Drive - Genesis',
  Dreamcast: 'Sega - Dreamcast'
}
const KINDS = { boxart: 'Named_Boxarts', snap: 'Named_Snaps', titleScreen: 'Named_Titles' }
const NAMES = { boxart: 'boxart.png', snap: 'snap.png', titleScreen: 'title.png' }
const DAY = 24 * 60 * 60 * 1000
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function cleanGameName(fileName) {
  const name = parse(fileName).name
  const region =
    name.match(/\((USA|Europe|Japan|World|UK|Australia|Korea|China)(?:[, )])/i)?.[1] || null
  const title =
    name
      .replace(/\s*(\([^)]*\)|\[[^\]]*\])/g, '')
      .replace(/\s+/g, ' ')
      .trim() || name
  return { title, region }
}

export function gameMediaId(game) {
  const slug =
    cleanGameName(game.fileName)
      .title.normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'game'
  const hash = createHash('sha256')
    .update(`${game.systemShort}:${game.fileName}${game.importKey ? ':' + game.importKey : ''}`)
    .digest('hex')
    .slice(0, 12)
  return `${game.systemShort.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${slug}-${hash}`
}

const normalized = (name) =>
  cleanGameName(`${name}.png`)
    .title.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
const exists = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true

// Dependency injection keeps CDN tests offline and never needs credentials.
export function createScraper({
  userData,
  fetchImpl = globalThis.fetch,
  onMediaUpdated = () => {},
  mediaTimeoutMs = 15000
}) {
  const mediaRoot = getMediaRoot(userData)
  const manifest = join(userData, 'games.json')
  let records = {}
  try {
    records = JSON.parse(fs.readFileSync(manifest, 'utf8')).games || {}
  } catch {
    /* First run or damaged cache. */
  }
  const catalogs = new Map()
  let inFlight = null
  let activeGames = new Map()
  let manifestQueue = Promise.resolve()
  let mediaQueue = Promise.resolve()
  const pendingMedia = new Set()
  const removed = new Set()
  const runningMedia = new Map()
  const downloadMedia = createMediaDownloader({ userData, fetchImpl, timeoutMs: mediaTimeoutMs })

  // Images and audio finish independently; serialize manifest mutations to avoid lost updates.
  function saveRecords(change) {
    const write = manifestQueue
      .catch(() => {})
      .then(async () => {
        change()
        await fs.promises.mkdir(userData, { recursive: true })
        await fs.promises.writeFile(
          `${manifest}.tmp`,
          JSON.stringify({ version: 1, games: records }, null, 2)
        )
        await fs.promises.rename(`${manifest}.tmp`, manifest)
      })
    manifestQueue = write
    return write
  }

  function recordFor(game, previous = {}) {
    return {
      gameId: game.gameId,
      fileName: game.fileName,
      title: game.title,
      platform: game.systemShort,
      region: game.region,
      year: null,
      developer: null,
      genre: null,
      ...previous,
      media: game.media
    }
  }

  function queueMedia(games, force) {
    if (force) downloadMedia.clearCatalogs()
    for (const original of games) {
      const game = enrich(original)
      removed.delete(game.gameId)
      if (pendingMedia.has(game.gameId)) continue
      const kinds = ['music', 'video'].filter(
        (kind) =>
          !game.media[kind] &&
          (force || Date.now() - (records[game.gameId]?.archiveCheckedAt?.[kind] || 0) >= DAY)
      )
      if (!kinds.length) continue
      pendingMedia.add(game.gameId)
      // One game at a time; its audio/video requests are independent of artwork and each other.
      mediaQueue = mediaQueue
        .then(async () => {
          if (!activeGames.has(game.gameId) || removed.has(game.gameId)) return
          const task = downloadMedia(enrich(game), {
            kinds,
            onResult: async (kind, path) => {
              let updated
              await saveRecords(() => {
                const current = activeGames.get(game.gameId)
                if (!current) return
                updated = enrich(current)
                const previous = records[game.gameId]
                records[game.gameId] = recordFor(updated, {
                  ...previous,
                  archiveCheckedAt: { ...previous?.archiveCheckedAt, [kind]: Date.now() }
                })
              })
              if (path && updated && activeGames.has(game.gameId)) onMediaUpdated(updated)
            }
          })
          runningMedia.set(game.gameId, task)
          try {
            await task
          } finally {
            runningMedia.delete(game.gameId)
          }
        })
        .catch(() => {
          /* Preview media is optional, including cache writes and closed renderer listeners. */
        })
        .finally(() => pendingMedia.delete(game.gameId))
    }
  }

  function enrich(game) {
    const gameId = gameMediaId(game)
    const metadata = cleanGameName(game.fileName)
    const directory = gameMediaDirectory(userData, gameId)
    const media = Object.fromEntries(
      Object.entries(NAMES).map(([kind, name]) => {
        const file = join(directory, name)
        return [kind, exists(file) ? file : null]
      })
    )
    for (const [kind, folder, suffix, cachedName] of [
      ['music', 'music', 'mp3', 'theme.mp3'],
      ['video', 'videos', 'mp4', 'preview.mp4']
    ]) {
      media[kind] =
        [join(directory, cachedName), join(mediaRoot, folder, `${gameId}.${suffix}`)].find(
          exists
        ) || null
    }
    return { ...game, ...metadata, gameId, media, mediaDirectory: directory }
  }

  async function request(url, limit) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'error' })
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Libretro HTTP ${response.status}`)
    }
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel()
      throw new Error('Medya boyutu sınırı aşıldı')
    }
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > limit) throw new Error('Medya boyutu sınırı aşıldı')
        chunks.push(Buffer.from(value))
      }
    } finally {
      await reader.cancel()
    }
    return Buffer.concat(chunks)
  }

  async function catalog(system, kind) {
    const base = `${CDN}${encodeURIComponent(system)}/${KINDS[kind]}/`
    if (!catalogs.has(base)) {
      catalogs.set(
        base,
        (async () => {
          const html = (await request(base, 8 * 1024 * 1024))?.toString('utf8') || ''
          const entries = []
          for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
            try {
              const url = new URL(match[1].replace(/&amp;/g, '&'), base)
              if (url.origin !== new URL(CDN).origin || !url.href.startsWith(base) || url.search)
                continue
              const name = decodeURIComponent(url.pathname.slice(new URL(base).pathname.length))
              if (name.includes('/') || !name.toLowerCase().endsWith('.png')) continue
              entries.push({ name, url: url.href, ...cleanGameName(name) })
            } catch {
              /* Ignore malformed links in an external listing. */
            }
          }
          return entries
        })()
      )
    }
    return catalogs.get(base)
  }

  async function scan(games, onProgress = () => {}, { force = false } = {}) {
    if (inFlight) return inFlight
    inFlight = (async () => {
      activeGames = new Map(games.map((game) => [gameMediaId(game), game]))
      queueMedia(games, force)
      catalogs.clear()
      let offline = false
      let warning = null
      let completed = 0
      let cursor = 0
      const nextRecords = {}
      const output = new Array(games.length)
      const worker = async () => {
        while (cursor < games.length) {
          const index = cursor++
          let game = enrich(games[index])
          if (removed.has(game.gameId)) continue
          const previous = records[game.gameId]
          let checkedAt = previous?.checkedAt || 0
          if (!offline && (force || Date.now() - checkedAt > DAY)) {
            try {
              const system =
                extname(game.fileName).toLowerCase() === '.gb'
                  ? 'Nintendo - Game Boy'
                  : SYSTEMS[game.systemShort]
              if (system) {
                for (const kind of Object.keys(KINDS)) {
                  if (removed.has(game.gameId)) break
                  if (game.media[kind] || offline) continue
                  const entries = await catalog(system, kind)
                  const candidates = entries.filter(
                    (entry) => normalized(entry.title) === normalized(game.title)
                  )
                  candidates.sort((a, b) => {
                    const score = (item) =>
                      (item.region?.toLowerCase() === game.region?.toLowerCase() ? 4 : 0) +
                      (item.name.slice(0, -4) === parse(game.fileName).name ? 8 : 0) +
                      (item.region === 'USA' ? 1 : 0)
                    return score(b) - score(a) || a.name.localeCompare(b.name)
                  })
                  if (!candidates.length) continue
                  const bytes = await request(candidates[0].url, 20 * 1024 * 1024)
                  if (removed.has(game.gameId)) break
                  if (!bytes) continue
                  if (!bytes.subarray(0, 8).equals(PNG)) throw new Error('Geçersiz PNG yanıtı')
                  await fs.promises.mkdir(game.mediaDirectory, { recursive: true })
                  const target = join(game.mediaDirectory, NAMES[kind])
                  await fs.promises.writeFile(`${target}.tmp`, bytes)
                  await fs.promises.rename(`${target}.tmp`, target)
                }
              }
              if (!offline) checkedAt = Date.now()
            } catch (error) {
              offline = true
              warning = `Medya indirilemedi; yerel önbellek kullanılıyor. ${error.message}`
            }
          }
          game = enrich(game)
          if (removed.has(game.gameId)) continue
          nextRecords[game.gameId] = recordFor(game, { checkedAt })
          output[index] = game
          onProgress({ completed: ++completed, total: games.length, game, warning })
        }
      }
      await Promise.all([worker(), worker()])
      await saveRecords(() => {
        for (const game of output) {
          if (!game || removed.has(game.gameId)) continue
          nextRecords[game.gameId].archiveCheckedAt = records[game.gameId]?.archiveCheckedAt || {}
          nextRecords[game.gameId].media = enrich(game).media
        }
        records = Object.fromEntries(Object.entries(nextRecords).filter(([id]) => !removed.has(id)))
      })
      return {
        games: output.filter((game) => game && !removed.has(game.gameId)).map(enrich),
        warning
      }
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }
  const forget = async (gameId) => {
    removed.add(gameId)
    activeGames.delete(gameId)
    await Promise.allSettled([inFlight, runningMedia.get(gameId)])
    await saveRecords(() => {
      delete records[gameId]
    })
  }
  return { enrich, scan, forget, whenMediaIdle: () => mediaQueue }
}
