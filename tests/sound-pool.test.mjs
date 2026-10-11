import test from 'node:test'
import assert from 'node:assert/strict'
import { createSoundPool } from '../src/renderer/src/hooks/soundPool.js'

function fixture() {
  const voices = [],
    starts = []
  const pool = createSoundPool(
    { navigate: 'navigate.wav', toggle: 'toggle.wav', back: 'back.wav', launch: 'launch.wav' },
    {
      createAudio: (url) => {
        const audio = {
          url,
          currentTime: 99,
          ended: false,
          pauses: 0,
          loads: 0,
          load() {
            this.loads++
          },
          pause() {
            this.pauses++
          },
          removeAttribute() {
            this.url = ''
          },
          play() {
            starts.push(this)
            return Promise.resolve()
          }
        }
        voices.push(audio)
        return audio
      }
    }
  )
  return { voices, starts, pool }
}

test('six preloaded voices overlap; bursts faster than 30ms and saturated pools never lose starts', () => {
  const { voices, starts, pool } = fixture()
  assert.equal(voices.filter((voice) => voice.url === 'navigate.wav').length, 6)
  assert(
    voices.every(
      (voice) =>
        voice.preload === 'auto' && voice.loads === 1 && voice.volume > 0 && voice.volume <= 0.4
    )
  )
  for (let i = 0; i < 6; i++) pool.play('navigate')
  assert.equal(new Set(starts).size, 6)
  assert(starts.every((voice) => voice.pauses === 0 && voice.currentTime === 0))
  for (let i = 0; i < 18; i++) pool.play('navigate')
  assert.equal(starts.length, 24)
  assert.equal(new Set(starts).size, 6, 'Bounded pool avoids allocating during navigation')
  assert.equal(
    starts[6],
    starts[0],
    'Oldest voice is recycled instead of dropping the new focus sound'
  )
  voices[2].onended()
  pool.play('navigate')
  assert.equal(starts.at(-1), voices[2], 'Finished voices are reused before active ones')
  pool.dispose()
})

test('menu mute stops navigation and toggle but launch remains independent; disposal is final', () => {
  const { voices, starts, pool } = fixture()
  pool.play('navigate')
  pool.play('toggle')
  pool.setEnabled(false)
  assert(voices.filter((voice) => voice.url !== 'launch.wav').every((voice) => voice.pauses > 0))
  pool.play('navigate')
  pool.play('toggle')
  pool.play('back')
  pool.play('__proto__')
  assert.equal(starts.length, 2)
  pool.play('launch')
  assert.equal(starts.length, 3)
  pool.setEnabled(true)
  pool.play('navigate')
  assert.equal(starts.length, 4)
  pool.dispose()
  assert(voices.every((voice) => voice.url === '' && voice.onended === null))
  pool.play('navigate')
  pool.play('launch')
  assert.equal(starts.length, 4)
})

test('missing device and rejected autoplay never break navigation or exhaust a pool permanently', async () => {
  const unavailable = createSoundPool(
    { navigate: 'missing.wav' },
    {
      createAudio: () => {
        throw Error('device missing')
      }
    }
  )
  assert.doesNotThrow(() => unavailable.play('navigate'))
  unavailable.dispose()
  const { pool, voices, starts } = fixture()
  voices[0].play = () => Promise.reject(Error('autoplay denied'))
  pool.play('navigate')
  await Promise.resolve()
  voices[0].play = function () {
    starts.push(this)
    return Promise.resolve()
  }
  pool.play('navigate')
  assert.equal(starts[0], voices[0])
  pool.dispose()
})
