import { setImmediate as yieldTurn } from 'node:timers/promises'

/** Keep bounded synchronous filesystem/metadata work from monopolizing Electron's main loop. */
export async function mapCooperatively(items, transform, batchSize = 8) {
  const result = []
  for (let index = 0; index < items.length; index++) {
    if (index % batchSize === 0) await yieldTurn()
    result.push(await transform(items[index], index))
  }
  return result
}

/** Share a scan across concurrent readers; invalidation during a scan never publishes stale data. */
export function createSnapshot(load) {
  let value,
    pending,
    revision = 0
  return {
    invalidate() {
      revision++
      value = undefined
    },
    async get({ fresh = false } = {}) {
      if (pending) {
        await pending
        return this.get()
      }
      if (fresh) {
        revision++
        value = undefined
      }
      if (value !== undefined) return value
      const started = revision
      pending = Promise.resolve().then(load)
      try {
        const result = await pending
        if (started === revision) value = result
      } finally {
        pending = null
      }
      // A mutation during traversal makes that result obsolete for all waiting readers.
      return value === undefined ? this.get() : value
    }
  }
}

/** Coalesce mutations while preserving an awaited durability boundary for every caller. */
export function createBatchedWriter(write, delay = 25) {
  let waiters = [],
    timer,
    running = null
  const flush = async () => {
    clearTimeout(timer)
    timer = null
    if (running) {
      // The owner rejects its own waiters; a concurrent flush must still drain later writes.
      await running.catch(() => {})
      return flush()
    }
    if (!waiters.length) return
    const batch = waiters
    waiters = []
    running = Promise.resolve().then(write)
    try {
      await running
      batch.forEach(({ resolve }) => resolve())
    } catch (error) {
      batch.forEach(({ reject }) => reject(error))
    } finally {
      running = null
    }
    if (waiters.length) return flush()
  }
  return {
    request() {
      const promise = new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      if (!timer)
        timer = setTimeout(() => {
          void flush()
        }, delay)
      return promise
    },
    flush
  }
}

/** Bounded optional work with a resumable gate. Active network requests use their own deadlines. */
export function createWorkQueue(concurrency = 2) {
  const jobs = [],
    idleWaiters = [],
    resumeWaiters = []
  let running = 0,
    paused = false
  const drain = () => {
    while (!paused && running < concurrency && jobs.length) {
      const { task, resolve, reject } = jobs.shift()
      running++
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          running--
          drain()
        })
    }
    if (!running && !jobs.length) idleWaiters.splice(0).forEach((resolve) => resolve())
  }
  return {
    schedule(task, priority = false) {
      const promise = new Promise((resolve, reject) => {
        jobs[priority ? 'unshift' : 'push']({ task, resolve, reject })
      })
      drain()
      return promise
    },
    setPaused(value) {
      paused = value
      if (!paused) resumeWaiters.splice(0).forEach((resolve) => resolve())
      drain()
    },
    ready: () =>
      paused ? new Promise((resolve) => resumeWaiters.push(resolve)) : Promise.resolve(),
    whenIdle: () =>
      !running && !jobs.length
        ? Promise.resolve()
        : new Promise((resolve) => idleWaiters.push(resolve))
  }
}

/** Send bounded progress batches, preserving every changed game and the latest counters. */
export function createProgressPublisher(send, transform = (game) => game, delay = 100) {
  let timer = null,
    latest = null
  const games = new Map()
  const flush = () => {
    clearTimeout(timer)
    timer = null
    if (!latest) return
    const update = { ...latest, games: [...games.values()] }
    latest = null
    games.clear()
    send(update)
  }
  return {
    report(update) {
      const game = update.game ? transform(update.game) : null
      latest = { ...update, game }
      if (game) games.set(game.id, game)
      if (!timer) timer = setTimeout(flush, delay)
    },
    flush
  }
}
