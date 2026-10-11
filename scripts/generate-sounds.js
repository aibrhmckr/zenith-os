import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SAMPLE_RATE = 44100
const durations = { navigate: 0.048, toggle: 0.09, back: 0.08, launch: 0.72 }

/** Original mono PCM voices: continuous phase sweeps and click-free attack/release envelopes. */
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
    const time = i / SAMPLE_RATE,
      fraction = i / (count - 1)
    const envelope = Math.min(1, time / 0.004) * Math.pow(1 - fraction, 2) * Math.exp(-fraction * 2)
    let sample = 0
    if (name === 'launch') {
      for (const [index, frequency] of [523.251, 659.255, 783.991, 1046.502].entries()) {
        const elapsed = time - index * 0.065
        if (elapsed >= 0)
          sample +=
            (Math.sin(2 * Math.PI * frequency * elapsed) *
              Math.min(1, elapsed / 0.025) *
              Math.exp(-elapsed * 5)) /
            4
      }
      sample *= Math.min(1, (duration - time) / 0.1) * 0.7
    } else {
      const [start, end] =
        name === 'navigate' ? [420, 210] : name === 'toggle' ? [320, 480] : [400, 260]
      const phase = 2 * Math.PI * (start * time + ((end - start) * time * time) / (2 * duration))
      sample = (Math.sin(phase) + 0.16 * Math.sin(phase * 2)) * envelope * 0.48
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
