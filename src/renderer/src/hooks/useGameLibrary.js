import { useEffect, useRef, useState, useCallback } from 'react'

export default function useGameLibrary() {
  const [games, setGames] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [warning, setWarning] = useState('')
  const busy = useRef(false)
  const mounted = useRef(false)
  const mediaUpdates = useRef(new Map())
  const withLatestMedia = useCallback((game) => {
    const update = mediaUpdates.current.get(game.gameId)
    if (!update) return game
    return {
      ...game,
      media: {
        ...game.media,
        music: game.media?.music || update.media.music,
        video: game.media?.video || update.media.video
      },
      musicUrl: game.musicUrl || update.musicUrl,
      videoUrl: game.videoUrl || update.videoUrl
    }
  }, [])
  const refresh = useCallback(
    async (force = true) => {
      while (busy.current) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (!mounted.current) return
      }
      busy.current = true
      mediaUpdates.current.clear()
      setScanning(true)
      setError('')
      setWarning('')
      setProgress(null)
      try {
        const local = await window.electronAPI.getLocalGames()
        if (!mounted.current) return
        setGames(local.map(withLatestMedia))
        setLoading(false)
        const result = await window.electronAPI.scanAndScrapeGames({ force })
        if (!mounted.current) return
        setGames(result.games.map(withLatestMedia))
        setWarning(result.warning || '')
      } catch (error) {
        console.error('Kütüphane taranamadı:', error)
        if (mounted.current)
          setError(
            'games klasörü okunamadı veya medya önbelleği yazılamadı. Erişim izinlerini kontrol edin.'
          )
      } finally {
        busy.current = false
        if (mounted.current) {
          setLoading(false)
          setScanning(false)
        }
      }
    },
    [withLatestMedia]
  )
  useEffect(() => {
    mounted.current = true
    const remove = window.electronAPI.onScrapeProgress((update) => {
      setProgress({ completed: update.completed, total: update.total })
      setGames((previous) =>
        previous.map((game) => (game.id === update.game.id ? withLatestMedia(update.game) : game))
      )
      if (update.warning) setWarning(update.warning)
    })
    const removeMedia = window.electronAPI.onGameMediaUpdated((update) => {
      mediaUpdates.current.set(update.gameId, update)
      setGames((previous) =>
        previous.map((game) =>
          game.gameId === update.gameId
            ? {
                ...game,
                media: { ...game.media, music: update.media.music, video: update.media.video },
                musicUrl: update.musicUrl,
                videoUrl: update.videoUrl
              }
            : game
        )
      )
    })
    const initialScan = setTimeout(() => {
      void refresh(false)
    }, 0)
    return () => {
      clearTimeout(initialScan)
      mounted.current = false
      remove()
      removeMedia()
    }
  }, [refresh, withLatestMedia])
  const removeFromState = useCallback((gameId) => {
    mediaUpdates.current.delete(gameId)
    setGames((previous) => previous.filter((game) => game.gameId !== gameId))
  }, [])
  return { games, loading, error, scanning, progress, warning, refresh, removeFromState }
}
