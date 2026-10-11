/** Preloaded, bounded HTML audio voices. A saturated pool reuses its oldest voice, never drops input. */
export function createSoundPool(sources, { createAudio = (url) => new Audio(url) } = {}) {
  let enabled = true,
    disposed = false,
    sequence = 0
  const pools = {}
  for (const [name, url] of Object.entries(sources)) {
    pools[name] = []
    for (let i = 0; i < (name === 'navigate' ? 6 : 2); i++) {
      try {
        const audio = createAudio(url)
        const voice = { audio, busy: false, order: 0, ticket: 0 }
        audio.preload = 'auto'
        audio.volume = name === 'launch' ? 0.38 : name === 'navigate' ? 0.26 : 0.32
        audio.onended = () => {
          voice.busy = false
        }
        audio.onerror = () => {
          voice.busy = false
        }
        audio.load()
        pools[name].push(voice)
      } catch {
        /* No audio device/implementation: keep navigation functional. */
      }
    }
  }
  const stop = (voice) => {
    voice.ticket++
    voice.busy = false
    try {
      voice.audio.pause()
      voice.audio.currentTime = 0
    } catch {
      /* Unavailable device. */
    }
  }
  const play = (name) => {
    const pool = Object.hasOwn(pools, name) ? pools[name] : null
    if (disposed || (!enabled && name !== 'launch') || !pool?.length) return
    const voice =
      pool.find((item) => !item.busy || item.audio.ended) ||
      pool.reduce((oldest, item) => (item.order < oldest.order ? item : oldest))
    if (voice.busy) stop(voice)
    voice.busy = true
    voice.order = ++sequence
    const ticket = ++voice.ticket
    try {
      voice.audio.currentTime = 0
      // Do not await, debounce or throttle: every focus event starts a voice in this turn.
      Promise.resolve(voice.audio.play()).catch(() => {
        if (voice.ticket === ticket) voice.busy = false
      })
    } catch {
      voice.busy = false
    }
  }
  return {
    play,
    setEnabled(value) {
      enabled = value
      if (!value)
        for (const name of ['navigate', 'toggle', 'back']) (pools[name] || []).forEach(stop)
    },
    dispose() {
      disposed = true
      for (const voice of Object.values(pools).flat()) {
        stop(voice)
        voice.audio.onended = null
        voice.audio.onerror = null
        try {
          voice.audio.removeAttribute('src')
          voice.audio.load()
        } catch {
          /* Device removed. */
        }
      }
    }
  }
}
