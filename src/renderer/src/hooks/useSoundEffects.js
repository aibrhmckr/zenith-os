import { useCallback, useEffect, useRef } from 'react'
import navigate from '../assets/sounds/navigate.wav'
import toggle from '../assets/sounds/toggle.wav'
import launch from '../assets/sounds/launch.wav'

/**
 * Vite-managed application WAV URLs; no generated tones or user-downloaded game sounds belong in
 * this pool.
 */
const SOURCES = { navigate, toggle, launch }
/**
 * Publish a named UI sound request to the single App-owned pool instead of creating competing
 * audio managers in every modal.
 *
 * @param {'navigate'|'toggle'|'launch'} name - UI sound action sent to the App-owned player.
 */
export const emitSound = (name) =>
  window.dispatchEvent(new CustomEvent('zenith-sound', { detail: name }))
/**
 * Pool four navigation voices and one toggle/launch voice each. Menu preference gates
 * navigation/toggle only; missing devices remain silent.
 *
 * @param {boolean} enabled - Enables navigation/toggle sounds; launch audio remains independent.
 */
export default function useSoundEffects(enabled = true) {
  /**
   * Persistent HTML5 Audio pools and last-navigation timestamp; refs avoid rerendering on every
   * sound.
   */
  const players = useRef({}),
    lastNavigate = useRef(-Infinity)
  /**
   * Play an allowed sound at 40% volume, throttle navigation bursts to 30 ms, and skip exhausted
   * pools rather than cutting off a playing navigation voice.
   *
   * @param {'navigate'|'toggle'|'launch'} name - Pool to play; unrecognized actions are ignored.
   */
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
          /**
           * Create an independent pool entry for each requested slot rather than reusing mutable objects.
           */
          () => new Audio(SOURCES[name])
        ))
        const audio =
          name === 'navigate'
            ? pool.find(
                /**
                 * Select the first matching pool entry for audio; absence is handled by the caller's fallback.
                 *
                 * @param {HTMLAudioElement} voice - Pool member checked for an available playback slot.
                 */
                (voice) => voice.paused || voice.ended
              )
            : pool[0]
        if (!audio) return
        audio.volume = 0.4
        audio.currentTime = 0
        void audio.play().catch(
          /**
           * Handle the rejected stage of play here so its failure follows this operation's fallback/error policy.
           */
          () => {}
        )
      } catch {
        /* Missing device or autoplay restriction stays silent. */
      }
    },
    [enabled]
  )
  /**
   * Silence navigation/toggle voices immediately when menu effects are disabled; launch remains
   * independent.
   */
  useEffect(() => {
    if (!enabled)
      for (const name of ['navigate', 'toggle']) {
        for (const audio of players.current[name] || []) {
          audio.pause()
          audio.currentTime = 0
        }
      }
  }, [enabled])
  /**
   * Consume shared sound events with the current preference-aware player and clean up the
   * listener.
   */
  useEffect(() => {
    /**
     * Forward a zenith-sound CustomEvent detail to the current preference-aware player.
     *
     * @param {Object} options - Named inputs for this operation.
     * @param {'navigate'|'toggle'|'launch'} options.detail - UI sound action from zenith-sound.
     */
    const receive = ({ detail }) => play(detail)
    window.addEventListener('zenith-sound', receive)
    /**
     * Release the listeners, timers, or focus ownership acquired by useSoundEffects's effect before it reruns or unmounts.
     */
    return () => window.removeEventListener('zenith-sound', receive)
  }, [play])
  /**
   * Release every Audio source and reset the pool on unmount.
   */
  useEffect(
    () =>
      /**
       * Dispose useSoundEffects's resources when the enclosing effect is cleaned up.
       */
      () => {
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
