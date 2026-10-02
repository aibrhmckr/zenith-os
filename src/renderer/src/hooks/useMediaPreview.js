import { useEffect, useMemo, useRef, useState, useCallback } from 'react'

/**
 * Own delayed preview playback and audio ramps for the selected game. Debounce 800 ms, fade in
 * 400 ms to 30%, fade departing music 150 ms, and fade before launch 500 ms.
 *
 * @param {Object} game - Library game record, including identity, platform, and available local media.
 * @param {boolean} enabled - Whether this hook may play previews or menu effects, as described above.
 * @param {boolean} sound - Enable preview audio or focus-change feedback; visual playback remains independently gated.
 */
export default function useMediaPreview(game, enabled, sound = false) {
  /**
   * Video element for the selected game; source changes remount it in App.
   */
  const videoRef = useRef(null)
  /**
   * Optional MP3 element; when present, it suppresses the video soundtrack.
   */
  const audioRef = useRef(null)
  /**
   * Departing audio elements and 150-ms fade timers that must be stopped on unmount.
   */
  const tails = useRef(new Map())
  /**
   * Latest session-specific cleanup callable from stable callbacks.
   */
  const stopRef = useRef(
    /**
     * Initial inert cleanup callback for stopRef; it is replaced once resources have been acquired.
     */
    () => {}
  )
  /**
   * Cancel only startup/fade-in work before applying a deliberate launch fade.
   */
  const stopRampRef = useRef(
    /**
     * Initial inert cleanup callback for stopRampRef; it is replaced once resources have been acquired.
     */
    () => {}
  )
  /**
   * Identity of the session whose debounce elapsed; stale sessions cannot enable cinematic
   * display.
   */
  const [readySession, setReadySession] = useState(null)
  /**
   * Focus/visibility gate keeps preview playback quiet when the dashboard is hidden.
   */
  const [visible, setVisible] = useState(!document.hidden)
  /**
   * Restart generation allows the same selected game to schedule a new preview.
   */
  const [intent, setIntent] = useState(0)
  const id = game?.gameId
  const musicUrl = game?.musicUrl
  const videoUrl = game?.videoUrl
  /**
   * Memoized identity ties playback to game URLs, preference, visibility, and explicit restart
   * intent.
   */
  const session = useMemo(
    () => ({ id, musicUrl, videoUrl, enabled, visible, sound, intent }),
    [id, musicUrl, videoUrl, enabled, visible, sound, intent]
  )
  /**
   * Cancel the current preview session and clear its cinematic-ready marker.
   */
  const stop = useCallback(() => {
    stopRef.current()
    setReadySession(null)
  }, [])
  /**
   * Stop playback and increment an intent token to retrigger the preview even if the game and URLs
   * are unchanged.
   */
  const restart = useCallback(() => {
    stop()
    setIntent(
      /**
       * Compute restart's next React state from the latest queued value, avoiding stale render snapshots.
       *
       * @param {*} value - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (value) => value + 1
    )
  }, [stop])
  /**
   * Cancel the startup ramp and resolve after the 500-ms launch fade has reduced active players to
   * silence.
   */
  const fadeOut = useCallback(
    () =>
      new Promise(
        /**
         * Bridge fadeOut's callback-based work into a Promise; settle it through the supplied resolve/reject functions.
         *
         * @param {*} resolve - Fulfill the pending operation.
         */
        (resolve) => {
          stopRampRef.current()
          const players = [audioRef.current, videoRef.current].filter(Boolean)
          const volumes = players.map(
            /**
             * Project each players entry for volumes; preserve input ordering in the derived collection.
             *
             * @param {*} media - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            (media) => media.volume
          )
          const start = performance.now()
          const timer = setInterval(
            /**
             * Advance timer's timed update; the surrounding lifecycle clears this interval when no longer needed.
             */
            () => {
              const progress = Math.min(1, (performance.now() - start) / 500)
              players.forEach(
                /**
                 * Apply timer's per-entry side effect to players; this callback does not build a result collection.
                 *
                 * @param {*} media - Value supplied by the enclosing operation; interpreted in this callback's local scope.
                 * @param {*} i - Zero-based collection index.
                 */
                (media, i) => {
                  media.volume = volumes[i] * (1 - progress)
                }
              )
              if (progress >= 1) {
                clearInterval(timer)
                stop()
                resolve()
              }
            },
            20
          )
        }
      ),
    [stop]
  )

  /**
   * Bind focus/visibility gates and remove their listeners on unmount.
   */
  useEffect(() => {
    /**
     * Stop playback on blur/hidden visibility so the dashboard does not compete with an emulator or
     * another application.
     */
    const hide = () => {
      stop()
      setVisible(false)
    }
    /**
     * Reflect document visibility when window focus returns; playback still observes its delay and
     * enable flags.
     */
    const show = () => setVisible(!document.hidden)
    /**
     * Route document visibility transitions through the same stop/resume gates as focus events.
     */
    const visibility = () => {
      if (document.hidden) hide()
      else show()
    }
    window.addEventListener('blur', hide)
    window.addEventListener('focus', show)
    document.addEventListener('visibilitychange', visibility)
    /**
     * Release the listeners, timers, or focus ownership acquired by useMediaPreview's effect before it reruns or unmounts.
     */
    return () => {
      window.removeEventListener('blur', hide)
      window.removeEventListener('focus', show)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [stop])

  /**
   * Schedule the current preview after 800 ms, fade playback in, and return cancellation/150-ms
   * tail cleanup for any session change.
   */
  useEffect(() => {
    const video = videoRef.current
    const audio = audioRef.current
    let cancelled = false
    let fade = 0
    let timer = 0
    /**
     * Cancel pending playback/ramp work, fade departing music briefly, and reset video immediately.
     * Track tails so unmount can release them.
     */
    const reset = () => {
      cancelled = true
      clearTimeout(timer)
      cancelAnimationFrame(fade)
      for (const media of [video, audio]) {
        if (!media) continue
        /**
         * Pause and rewind the departing media element after its fade; tolerate metadata that is not
         * loaded yet.
         */
        const finish = () => {
          media.pause()
          media.volume = 0
          try {
            media.currentTime = 0
          } catch {
            /* metadata pending */
          }
        }
        if (media === audio && media.volume > 0) {
          if (tails.current.has(media)) continue
          const volume = media.volume,
            started = performance.now()
          const fadeTimer = setInterval(
            /**
             * Advance fadeTimer's timed update; the surrounding lifecycle clears this interval when no longer needed.
             */
            () => {
              const progress = Math.min(1, (performance.now() - started) / 150)
              media.volume = volume * (1 - progress)
              if (progress >= 1) {
                clearInterval(fadeTimer)
                tails.current.delete(media)
                finish()
              }
            },
            10
          )
          tails.current.set(media, fadeTimer)
        } else finish()
      }
    }
    stopRef.current = reset
    stopRampRef.current =
      /**
       * Cancel startup playback and fade-in before the launch fade takes ownership of the media volume.
       */
      () => {
        clearTimeout(timer)
        cancelAnimationFrame(fade)
        cancelled = true
      }
    if (session.enabled && session.visible && session.id) {
      timer = setTimeout(
        /**
         * Run delayed useMediaPreview work only after the owning debounce/wait expires; the surrounding lifecycle owns cancellation.
         */
        async () => {
          if (cancelled) return
          setReadySession(session)
          const playable = []
          if (video && session.videoUrl) {
            video.muted = Boolean(session.musicUrl) || !session.sound
            playable.push(video)
          }
          if (audio && session.musicUrl && session.sound) {
            audio.muted = false
            playable.push(audio)
          }
          const playing = []
          for (const media of playable) {
            media.volume = 0
            try {
              await media.play()
              if (cancelled) {
                media.pause()
                media.currentTime = 0
                return
              }
              playing.push(media)
            } catch {
              /* Autoplay or codec failure leaves the static artwork usable. */
            }
          }
          if (cancelled) return
          const start = performance.now()
          /**
           * Raise successfully playing elements to a maximum volume of 0.3 over 400 ms, stopping when the
           * session is canceled.
           *
           * @param {number} now - Animation-frame timestamp in milliseconds.
           */
          const ramp = (now) => {
            if (cancelled) return
            const volume = Math.min(0.3, ((now - start) / 400) * 0.3)
            playing.forEach(
              /**
               * Apply ramp's per-entry side effect to playing; this callback does not build a result collection.
               *
               * @param {*} media - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               */
              (media) => {
                media.volume = volume
              }
            )
            if (volume < 0.3) fade = requestAnimationFrame(ramp)
          }
          fade = requestAnimationFrame(ramp)
        },
        800
      )
    }
    return reset
  }, [session])
  /**
   * Stop all remaining audio tails and clear their timers when the preview owner unmounts.
   */
  useEffect(
    () =>
      /**
       * Dispose useMediaPreview's resources when the enclosing effect is cleaned up.
       */
      () => {
        for (const [audio, timer] of tails.current) {
          clearInterval(timer)
          audio.pause()
          audio.volume = 0
          audio.currentTime = 0
        }
        tails.current.clear()
      },
    []
  )
  return {
    videoRef,
    audioRef,
    cinematic: enabled && visible && readySession === session,
    stop,
    fadeOut,
    restart
  }
}
