// Local synthetic fixtures only: no ROMs, external requests or user profile mutations.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { createScraper } from '../src/main/services/scraper.js'
import { createProgressPublisher } from '../src/main/services/workScheduling.js'
import { extractCoreAsync } from '../src/main/services/coreManager.js'
import { coreArchive, coreBinary } from '../tests/fixtures/core-archive.cjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-benchmark-'))
const results = []
try {
  for (const count of [100, 1000, 5000]) {
    for (const cached of [false, true]) {
      const userData = path.join(root, `${count}-${cached}`)
      let requests = 0,
        events = 0,
        stats = 0
      const scraper = createScraper({
        userData,
        logger: { log() {} },
        getPreferences: () => ({
          downloadCovers: cached,
          downloadBackgrounds: cached,
          downloadVideos: cached,
          downloadAudio: cached
        }),
        fetchImpl: async () => {
          requests++
          throw Error('Benchmark must remain offline')
        }
      })
      const games = Array.from({ length: count }, (_, i) => ({
        id: String(i),
        fileName: `Fixture ${i}.nds`,
        systemShort: 'NDS'
      }))
      if (cached)
        for (const game of games) {
          const dir = scraper.enrich(game).mediaDirectory
          fs.mkdirSync(dir, { recursive: true })
          for (const name of ['boxart.png', 'snap.png', 'theme.mp3', 'preview.mp4'])
            fs.writeFileSync(path.join(dir, name), 'synthetic-cache')
        }
      const original = fs.statSync
      fs.statSync = (...args) => {
        stats++
        return original(...args)
      }
      const delay = monitorEventLoopDelay({ resolution: 10 })
      delay.enable()
      const publisher = createProgressPublisher(() => events++)
      const start = performance.now()
      let firstTurnMs
      const heartbeat = new Promise((resolve) =>
        setImmediate(() => {
          firstTurnMs = performance.now() - start
          resolve()
        })
      )
      try {
        await scraper.scan(games, publisher.report)
        await scraper.whenMediaIdle()
        await scraper.flush()
        publisher.flush()
        await heartbeat
        results.push({
          count,
          cached,
          elapsedMs: Math.round(performance.now() - start),
          firstTurnMs: +firstTurnMs.toFixed(2),
          maxLoopDelayMs: +(delay.max / 1e6).toFixed(2),
          statCalls: stats,
          ipcEvents: events,
          networkRequests: requests
        })
      } finally {
        fs.statSync = original
        delay.disable()
      }
    }
  }
  const name = 'benchmark_libretro.dll',
    binary = Buffer.alloc(50 * 1024 * 1024)
  coreBinary(name).copy(binary)
  const zip = coreArchive(name, binary)
  const start = performance.now()
  let firstTurnMs
  const heartbeat = new Promise((resolve) =>
    setImmediate(() => {
      firstTurnMs = performance.now() - start
      resolve()
    })
  )
  await extractCoreAsync(zip, name, 'win32')
  await heartbeat
  console.log(
    JSON.stringify(
      {
        machine: {
          platform: process.platform,
          node: process.version,
          cpu: os.cpus()[0]?.model,
          memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1)
        },
        scans: results,
        core50MiB: {
          elapsedMs: Math.round(performance.now() - start),
          firstTurnMs: +firstTurnMs.toFixed(2)
        }
      },
      null,
      2
    )
  )
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
