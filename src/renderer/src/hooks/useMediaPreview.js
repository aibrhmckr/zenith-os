import { useEffect, useMemo, useRef, useState, useCallback } from 'react'

export default function useMediaPreview(game, enabled, sound = false) {
  const videoRef = useRef(null)
  const audioRef = useRef(null)
  const tails = useRef(new Map())
  const stopRef = useRef(() => {})
  const stopRampRef = useRef(() => {})
  const [readySession, setReadySession] = useState(null)
  const [visible, setVisible] = useState(!document.hidden)
  const [intent, setIntent] = useState(0)
  const id = game?.gameId
  const musicUrl = game?.musicUrl
  const videoUrl = game?.videoUrl
  const session = useMemo(
    () => ({ id, musicUrl, videoUrl, enabled, visible, sound, intent }),
    [id, musicUrl, videoUrl, enabled, visible, sound, intent]
  )
  const stop = useCallback(() => {
    stopRef.current()
    setReadySession(null)
  }, [])
  const restart = useCallback(() => {
    stop()
    setIntent((value) => value + 1)
  }, [stop])
  const fadeOut = useCallback(
    () =>
      new Promise((resolve) => {
        stopRampRef.current()
        const players = [audioRef.current, videoRef.current].filter(Boolean)
        const volumes = players.map((media) => media.volume)
        const start = performance.now()
        const timer = setInterval(() => {
          const progress = Math.min(1, (performance.now() - start) / 500)
          players.forEach((media, i) => {
            media.volume = volumes[i] * (1 - progress)
          })
          if (progress >= 1) {
            clearInterval(timer)
            stop()
            resolve()
          }
        }, 20)
      }),
    [stop]
  )

  useEffect(() => {
    const hide = () => {
      stop()
      setVisible(false)
    }
    const show = () => setVisible(!document.hidden)
    const visibility = () => {
      if (document.hidden) hide()
      else show()
    }
    window.addEventListener('blur', hide)
    window.addEventListener('focus', show)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('blur', hide)
      window.removeEventListener('focus', show)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [stop])

  useEffect(() => {
    const video = videoRef.current
    const audio = audioRef.current
    let cancelled = false
    let fade = 0
    let timer = 0
    const reset = () => {
      cancelled = true
      clearTimeout(timer)
      cancelAnimationFrame(fade)
      for (const media of [video, audio]) {
        if (!media) continue
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
          const fadeTimer = setInterval(() => {
            const progress = Math.min(1, (performance.now() - started) / 150)
            media.volume = volume * (1 - progress)
            if (progress >= 1) {
              clearInterval(fadeTimer)
              tails.current.delete(media)
              finish()
            }
          }, 10)
          tails.current.set(media, fadeTimer)
        } else finish()
      }
    }
    stopRef.current = reset
    stopRampRef.current = () => {
      clearTimeout(timer)
      cancelAnimationFrame(fade)
      cancelled = true
    }
    if (session.enabled && session.visible && session.id) {
      timer = setTimeout(async () => {
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
        const ramp = (now) => {
          if (cancelled) return
          const volume = Math.min(0.3, ((now - start) / 400) * 0.3)
          playing.forEach((media) => {
            media.volume = volume
          })
          if (volume < 0.3) fade = requestAnimationFrame(ramp)
        }
        fade = requestAnimationFrame(ramp)
      }, 800)
    }
    return reset
  }, [session])
  useEffect(
    () => () => {
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
