import fs from 'node:fs'
import { join } from 'node:path'
import { mediaRoot, gameMediaDirectory } from './mediaPaths.js'

export const DEFAULT_GUIDE_FEATURES = { manualsEnabled: true, loreEnabled: true }
const ARCHIVE = 'https://archive.org'
const WIKI = 'https://en.wikipedia.org'
const DAY = 86400000
const exists = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
const validId = (id) => typeof id === 'string' && /^[a-z\d][a-z\d._-]*$/i.test(id)
const normalized = (value) =>
  String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
const quote = (value) => `"${value.replace(/[\\"]/g, '\\$&')}"`
const manualTitle = (value) =>
  normalized(
    String(value)
      .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
      .replace(/\s*[-:]?\s*(?:instruction\s+)?(?:manual|manual scans|instruction booklet)\s*$/i, '')
  )

function allowed(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  if (url.origin === WIKI) return url.pathname.startsWith('/api/rest_v1/page/summary/')
  return (
    (url.hostname === 'archive.org' ||
      /^(?:ia|dn)\d+\.(?:[a-z]+\.)?archive\.org$/.test(url.hostname)) &&
    /^\/(advancedsearch\.php|metadata\/|download\/|BookReader\/|\d+\/items\/)/.test(url.pathname)
  )
}

// Every request has one deadline for redirects, headers and body. Never render remote HTML.
async function request(url, { fetchImpl, timeoutMs }, limit = 2 * 1024 * 1024) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let reader
  try {
    let current = new URL(url)
    let response
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (!allowed(current)) throw Error('Unsupported guide URL')
      response = await fetchImpl(current.href, { signal: controller.signal, redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      await response.body?.cancel()
      if (redirects === 4 || !response.headers.get('location')) throw Error('Redirect limit')
      current = new URL(response.headers.get('location'), current)
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel()
      throw Error('Guide unavailable')
    }
    reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw Error('Guide size limit')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
    controller.abort()
    await reader?.cancel().catch(() => {})
  }
}

export function createGuideService({
  userData,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  features = {}
}) {
  mediaRoot(userData)
  let flags = { ...DEFAULT_GUIDE_FEATURES, ...features }
  const options = { fetchImpl, timeoutMs }
  const pending = new Map()
  const json = async (url) => JSON.parse((await request(url, options)).toString('utf8'))
  const directory = (game) => {
    if (!game || !/^[a-z0-9][a-z0-9-]{0,150}$/.test(game.gameId) || typeof game.title !== 'string')
      throw Error('Unknown game')
    return gameMediaDirectory(userData, game.gameId)
  }
  function coalesce(key, task) {
    if (!pending.has(key))
      pending.set(
        key,
        Promise.resolve()
          .then(task)
          .catch(() => null)
          .finally(() => pending.delete(key))
      )
    return pending.get(key)
  }
  function read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  async function save(file, value) {
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2))
    await fs.promises.rename(`${file}.tmp`, file)
  }
  async function getLore(game) {
    if (!flags.loreEnabled) return null
    return coalesce(`lore:${game?.gameId}`, async () => {
      const dir = directory(game)
      const file = join(dir, 'lore.json')
      const cached = read(file)
      if (cached?.lore || Date.now() - cached?.checkedAt < DAY) return cached.lore
      // Disambiguate generic names such as Doom without choosing an unrelated article.
      for (const title of [game.title, `${game.title} (video game)`]) {
        try {
          const summary = await json(
            `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(' ', '_'))}`
          )
          if (summary.type === 'disambiguation' || typeof summary.extract !== 'string') continue
          if (
            !/\b(video game|game developed|platform game|shooter game|role-playing game)\b/i.test(
              `${summary.description || ''} ${summary.extract}`
            )
          )
            continue
          if (
            normalized(String(summary.title).replace(/\([^)]*\)/g, '')) !== normalized(game.title)
          )
            continue
          const intro = summary.extract.split('\n')[0].slice(0, 1400)
          const year =
            `${summary.description || ''} ${intro}`.match(/\b(?:19|20)\d{2}\b/)?.[0] || null
          const developer =
            intro
              .match(
                /\bdeveloped by\s+(.+?)(?=\s+and published|\s+and released|\s+for the|\.|;|$)/i
              )?.[1]
              ?.trim() || null
          const lore = {
            summary: intro,
            year,
            developer,
            sourceTitle: 'Wikipedia (English)',
            sourceUrl: `${WIKI}/wiki/${encodeURIComponent((summary.titles?.canonical || title).replaceAll(' ', '_'))}`
          }
          if (!flags.loreEnabled) return null
          await fs.promises.mkdir(dir, { recursive: true })
          await save(file, { checkedAt: Date.now(), lore })
          return lore
        } catch {
          /* Try the explicit video-game title, then use the static empty state. */
        }
      }
      return null
    })
  }
  async function getManual(game) {
    if (!flags.manualsEnabled) return null
    return coalesce(`manual:${game?.gameId}`, async () => {
      const dir = join(directory(game), 'manual')
      const file = join(dir, 'index.json')
      const cached = read(file)
      if (
        validId(cached?.identifier) &&
        Array.isArray(cached.leaves) &&
        cached.leaves.length &&
        cached.leaves.every((leaf) => Number.isInteger(leaf) && leaf >= 0 && leaf < 10000)
      )
        return cached
      const search = async (q) => {
        const params = new URLSearchParams({
          q,
          'fl[]': 'identifier,title,collection',
          rows: '8',
          output: 'json'
        })
        const result = await json(`${ARCHIVE}/advancedsearch.php?${params}`)
        return Array.isArray(result?.response?.docs)
          ? result.response.docs.filter(
              (doc) =>
                validId(doc?.identifier) &&
                !/hint[_ -]*guide|strategy|walkthrough/i.test(
                  `${doc.title || ''} ${doc.identifier}`
                ) &&
                manualTitle(doc.title || game.title) === normalized(game.title)
            )
          : []
      }
      let docs = await search(`collection:(videogamemanuals) AND title:(${quote(game.title)})`)
      if (!docs.length)
        docs = await search(
          `(collection:manuals OR collection:consolemanuals) AND title:(${quote(game.title)})`
        )
      const platform = normalized(game.systemShort)
      const score = (doc) =>
        (normalized(`${doc.identifier} ${doc.collection || ''}`).includes(platform) ? 4 : 0) +
        (game.region && doc.title?.toLowerCase().includes(game.region.toLowerCase()) ? 1 : 0)
      docs.sort((a, b) => score(b) - score(a))
      for (const doc of docs.slice(0, 3)) {
        try {
          const metadata = await json(`${ARCHIVE}/metadata/${encodeURIComponent(doc.identifier)}`)
          if (
            metadata.is_dark ||
            ['true', true, '1', 1].includes(metadata.metadata?.['access-restricted-item'])
          )
            continue
          const scan = metadata.files?.find(
            (entry) => /_scandata\.xml$/i.test(entry.name) && !entry.private
          )
          if (!scan || scan.name.includes('/') || scan.name.includes('\\')) continue
          const xml = (
            await request(
              `${ARCHIVE}/download/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(scan.name)}`,
              options
            )
          ).toString('utf8')
          const leaves = [
            ...xml.matchAll(/<page\b[^>]*\bleafNum=["'](\d+)["'][^>]*>([\s\S]*?)<\/page>/gi)
          ]
            .filter(
              (match) => !/<addToAccessFormats>\s*false\s*<\/addToAccessFormats>/i.test(match[2])
            )
            .map((match) => Number(match[1]))
            .filter((leaf) => leaf >= 0 && leaf < 10000)
            .slice(0, 512)
          if (!leaves.length || !flags.manualsEnabled) continue
          const manual = {
            identifier: doc.identifier,
            title: doc.title || game.title,
            leaves: [...new Set(leaves)],
            sourceUrl: `${ARCHIVE}/details/${encodeURIComponent(doc.identifier)}`
          }
          await fs.promises.mkdir(dir, { recursive: true })
          await save(file, manual)
          return manual
        } catch {
          /* A missing scan should not prevent another matching manual. */
        }
      }
      return null
    })
  }
  async function getPage(game, index) {
    if (!flags.manualsEnabled || !Number.isInteger(index) || index < 0 || index >= 512) return null
    return coalesce(`page:${game?.gameId}:${index}`, async () => {
      const manual = await getManual(game)
      if (!flags.manualsEnabled || !manual || index >= manual.leaves.length) return null
      const dir = join(directory(game), 'manual')
      const file = join(dir, `${manual.identifier}-page-${manual.leaves[index]}.jpg`)
      if (exists(file)) return file
      const bytes = await request(
        `${ARCHIVE}/download/${encodeURIComponent(manual.identifier)}/page/n${manual.leaves[index]}.jpg`,
        options,
        8 * 1024 * 1024
      )
      if (
        bytes.length < 4 ||
        !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
        !flags.manualsEnabled
      )
        return null
      try {
        await fs.promises.writeFile(`${file}.tmp`, bytes)
        await fs.promises.rename(`${file}.tmp`, file)
      } finally {
        await fs.promises.rm(`${file}.tmp`, { force: true }).catch(() => {})
      }
      return file
    })
  }
  return {
    whenIdle: () => Promise.allSettled([...pending.values()]),
    getLore,
    getManual,
    getPage,
    getFeatures: () => ({ ...flags }),
    setFeatures: (next) => {
      for (const key of Object.keys(DEFAULT_GUIDE_FEATURES))
        if (typeof next?.[key] === 'boolean') flags[key] = next[key]
      return { ...flags }
    }
  }
}
