import fs from 'node:fs'
import { join } from 'node:path'
import { buildbotBase, CORE_FILES, installedCorePath } from './coreManager.js'

const LABELS = {
  stella: 'Stella · Atari 2600',
  prosystem: 'ProSystem · Atari 7800',
  mednafen_lynx: 'Beetle Lynx · Atari Lynx',
  gearlynx: 'Gearlynx · Atari Lynx',
  atari800: 'Atari800 · Atari 800 / 5200',
  a5200: 'Atari 5200',
  mesen: 'Mesen · NES',
  desmume: 'DeSmuME · Nintendo DS',
  pcsx2: 'PCSX2 · PlayStation 2',
  lrps2: 'LRPS2 · PlayStation 2'
}
export function createCoreCatalog({
  retroarchDir,
  userData,
  platform = process.platform,
  fetchImpl = globalThis.fetch
}) {
  const suffix = platform === 'linux' ? '.so' : '.dll'
  const valid = (name) =>
    typeof name === 'string' &&
    /^[a-z0-9_-]+_libretro\.(dll|so)$/i.test(name) &&
    name.endsWith(suffix)
  const cacheFile = join(userData, 'core-catalog-' + platform + '.json')
  const selectionsFile = join(userData, 'core-selections.json')
  let names = [],
    selections = {},
    pending,
    loadedAt = 0
  try {
    names = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).filter(valid)
  } catch {
    /* first run */
  }
  try {
    selections = JSON.parse(fs.readFileSync(selectionsFile, 'utf8')) || {}
  } catch {
    /* first run */
  }
  const installed = () => {
    try {
      return fs
        .readdirSync(join(retroarchDir, 'cores'), { withFileTypes: true })
        .filter(
          (f) => f.isFile() && valid(f.name) && installedCorePath(retroarchDir, f.name, platform)
        )
        .map((f) => f.name)
    } catch {
      return []
    }
  }
  const entries = () => {
    const local = new Set(installed())
    return [...new Set([...names, ...local])]
      .map((fileName) => {
        const stem = fileName.replace(/_libretro\.(dll|so)$/, '')
        return {
          fileName,
          name: LABELS[stem] || stem.replaceAll('_', ' '),
          installed: local.has(fileName)
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.fileName.localeCompare(b.fileName))
  }
  const list = () => {
    if (loadedAt && Date.now() - loadedAt < 3600000)
      return Promise.resolve({ success: true, cores: entries(), offline: false })
    if (pending) return pending
    pending = (async () => {
      try {
        if (!['win32', 'linux'].includes(platform)) throw Error('Unsupported host platform.')
        const response = await fetchImpl(buildbotBase(platform), {
          signal: AbortSignal.timeout(10000),
          redirect: 'error'
        })
        if (!response.ok || !response.body) throw Error('Core catalog unavailable.')
        const chunks = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > 2 * 1024 * 1024) throw Error('Core catalog too large.')
          chunks.push(Buffer.from(chunk))
        }
        const html = Buffer.concat(chunks).toString('utf8')
        const found = [...html.matchAll(/href=["']([^"']+)["']/gi)].flatMap(([, href]) => {
          try {
            const url = new URL(href, buildbotBase(platform)),
              base = new URL(buildbotBase(platform))
            if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search)
              return []
            const name = decodeURIComponent(url.pathname.slice(base.pathname.length)).replace(
              /\.zip$/,
              ''
            )
            return url.pathname.endsWith('.zip') && valid(name) ? [name] : []
          } catch {
            return []
          }
        })
        if (!found.length) throw Error('Core catalog is empty.')
        names = [...new Set(found)]
        loadedAt = Date.now()
        await fs.promises.mkdir(userData, { recursive: true })
        await fs.promises.writeFile(cacheFile, JSON.stringify(names))
        return { success: true, cores: entries(), offline: false }
      } catch (error) {
        return {
          success: entries().length > 0,
          cores: entries(),
          offline: true,
          error: error.message
        }
      }
    })().finally(() => {
      pending = null
    })
    return pending
  }
  const allowed = async (name) =>
    valid(name) && (await list()).cores.some((core) => core.fileName === name)
  const get = (gameId, system) => {
    const name = selections['game:' + gameId] || selections['platform:' + system]
    return valid(name) && installedCorePath(retroarchDir, name, platform) ? name : null
  }
  const save = async () => {
    await fs.promises.mkdir(userData, { recursive: true })
    await fs.promises.writeFile(selectionsFile, JSON.stringify(selections, null, 2))
  }
  const select = async (key, name) => {
    if (!valid(name)) throw Error('Invalid core.')
    selections[key] = name
    await save()
  }
  const forget = async (gameId) => {
    delete selections['game:' + gameId]
    await save()
  }
  return { list, allowed, get, select, forget }
}

export function biosPlatformForCore(fileName, fallback) {
  for (const system of ['PS2', 'PS1', 'Dreamcast'])
    if (
      CORE_FILES[system].some(
        (name) => name.replace(/\.dll$/, '') === fileName.replace(/\.(dll|so)$/, '')
      )
    )
      return system
  return fallback
}
