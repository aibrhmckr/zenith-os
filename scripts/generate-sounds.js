import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SAMPLE_RATE = 44100
const durations = { navigate: 0.085, toggle: 0.22, back: 0.2, launch: 0.9 }

/** Raised-cosine edges prevent clicks without a pitch slide or a harsh noise transient. */
function envelope(time, duration, attack, decay) {
  if (time < 0 || time >= duration) return 0
  const fadeIn = (1 - Math.cos(Math.PI * Math.min(1, time / attack))) / 2
  const fadeOut = (1 - Math.cos(Math.PI * Math.min(1, (duration - time) / 0.035))) / 2
  return fadeIn * fadeOut * Math.exp(-time / decay)
}

/** Soft tuned resonator: most energy stays in the fundamental, with a quiet rounded overtone. */
function note(time, frequency, duration, attack = 0.008, decay = 0.06) {
  const phase = 2 * Math.PI * frequency * time
  return (
    envelope(time, duration, attack, decay) *
    (Math.sin(phase) + 0.12 * Math.sin(phase * 2) * Math.exp(-time / 0.025))
  )
}

/**
 * Original quiet console cues, not recordings/samples from another console.
 * Design reference: PlayStation's UX walkthrough (2020/10/15, blog.playstation.com).
 * Navigation is a short ceramic tap; confirmation/back are ascending/descending intervals;
 * launch is a soft suspended chord with a longer tail. No laser-like frequency sweeps.
 * Mono PCM retains compatibility with the preloaded six-voice HTML audio pool.
 */
export function synthesize(name) {
  if (!Object.hasOwn(durations, name)) throw new Error('Unknown sound profile')
  const duration = durations[name],
    count = Math.round(duration * SAMPLE_RATE)
  const wav = Buffer.alloc(44 + count * 2)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(SAMPLE_RATE, 24)
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(count * 2, 40)
  for (let i = 0; i < count; i++) {
    const time = i / SAMPLE_RATE
    let sample = 0
    if (name === 'launch') {
      for (const [index, frequency] of [261.626, 391.995, 523.251, 659.255].entries()) {
        const start = index * 0.055
        sample += note(time - start, frequency, duration - start, 0.04, 0.24) * 0.17
      }
    } else if (name === 'navigate') {
      sample = note(time, 660, duration, 0.006, 0.019) * 0.38
    } else {
      const [first, second] = name === 'toggle' ? [523.251, 783.991] : [659.255, 440]
      sample =
        note(time, first, duration, 0.009, 0.045) * 0.3 +
        note(time - 0.045, second, duration - 0.045, 0.012, 0.05) * 0.24
    }
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + i * 2)
  }
  return wav
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = new URL('../src/renderer/src/assets/sounds/', import.meta.url)
  mkdirSync(output, { recursive: true })
  for (const name of Object.keys(durations)) {
    writeFileSync(new URL(name + '.wav', output), synthesize(name))
    console.log(`Generated ${name}.wav (${durations[name] * 1000} ms, PCM 44.1 kHz / 16-bit)`)
  }
}
