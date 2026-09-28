import { useCallback, useEffect, useRef } from 'react'
import navigate from '../assets/sounds/navigate.wav'
import toggle from '../assets/sounds/toggle.wav'
import launch from '../assets/sounds/launch.wav'

const SOURCES = { navigate, toggle, launch }
export const emitSound = (name) =>
  window.dispatchEvent(new CustomEvent('zenith-sound', { detail: name }))
export default function useSoundEffects(enabled = true) {
  const players = useRef({}),
    lastNavigate = useRef(-Infinity)
  const play = useCallback(
    (name) => {
      if (!SOURCES[name] || (!enabled && name !== 'launch')) return
      if (name === 'navigate') {
        if (performance.now() - lastNavigate.current < 30) return
        lastNavigate.current = performance.now()
      }
      try {
        const pool = (players.current[name] ||= Array.from(
          { length: name === 'navigate' ? 4 : 1 },
          () => new Audio(SOURCES[name])
        ))
        const audio =
          name === 'navigate' ? pool.find((voice) => voice.paused || voice.ended) : pool[0]
        if (!audio) return
        audio.volume = 0.4
        audio.currentTime = 0
        void audio.play().catch(() => {})
      } catch {
        /* Missing device or autoplay restriction stays silent. */
      }
    },
    [enabled]
  )
  useEffect(() => {
    if (!enabled)
      for (const name of ['navigate', 'toggle']) {
        for (const audio of players.current[name] || []) {
          audio.pause()
          audio.currentTime = 0
        }
      }
  }, [enabled])
  useEffect(() => {
    const receive = ({ detail }) => play(detail)
    window.addEventListener('zenith-sound', receive)
    return () => window.removeEventListener('zenith-sound', receive)
  }, [play])
  useEffect(
    () => () => {
      for (const audio of Object.values(players.current).flat()) {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
      players.current = {}
    },
    []
  )
  return { play }
}
