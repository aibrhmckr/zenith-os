import { useEffect, useRef, useState, useCallback } from 'react'

/**
 * Own initial disk scanning, background scraping, progress, and live media IPC subscriptions.
 * Tear down listeners on unmount and preserve late preview updates.
 */
export default function useGameLibrary() {
  /**
   * Current decorated library records, replaced by scans and patched by asynchronous media events.
   */
  const [games, setGames] = useState([])
  /**
   * Initial local-library load state; artwork scraping continues after this becomes false.
   */
  const [loading, setLoading] = useState(true)
  /**
   * Fatal library/cache operation feedback, separate from optional-provider warnings.
   */
  const [error, setError] = useState('')
  /**
   * Visible scan indicator, independent from the already usable local game list.
   */
  const [scanning, setScanning] = useState(false)
  /**
   * Completed/total artwork counts supplied by Main.
   */
  const [progress, setProgress] = useState(null)
  /**
   * Nonfatal media-provider warning; local games remain available.
   */
  const [warning, setWarning] = useState('')
  /**
   * Immediate scan lock serializes refresh requests.
   */
  const busy = useRef(false)
  /**
   * Ignore callbacks after unmount, including delayed refresh waiters.
   */
  const mounted = useRef(false)
  /**
   * Latest preview events by game ID, merged into slower artwork scan responses.
   */
  const mediaUpdates = useRef(new Map())
  /**
   * Merge completed audio/video events into a slower artwork response so arriving snapshots do not
   * erase newly downloaded previews.
   *
   * @param {Object} game - Library game record, including identity, platform, and available local media.
   */
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
  /**
   * Serialize rescans, show local records before scraping, and ignore results after unmount.
   * Explicit refresh bypasses provider cooldowns by default.
   *
   * @param {boolean} force - Bypass provider lookup cooldowns for an explicit rescan.
   */
  const refresh = useCallback(
    async (force = true) => {
      while (busy.current) {
        await new Promise(
          /**
           * Bridge refresh's callback-based work into a Promise; settle it through the supplied resolve/reject functions.
           *
           * @param {*} resolve - Fulfill the pending operation.
           */
          (resolve) => setTimeout(resolve, 50)
        )
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
  /**
   * Subscribe before the initial scan so fast preview events are retained; cancel startup and
   * unsubscribe when the hook unmounts.
   */
  useEffect(() => {
    mounted.current = true
    const remove = window.electronAPI.onScrapeProgress(
      /**
       * Consume onScrapeProgress application payloads in remove; the enclosing effect disposes the IPC subscription on unmount.
       *
       * @param {*} update - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (update) => {
        setProgress({ completed: update.completed, total: update.total })
        setGames(
          /**
           * Compute remove's next React state from the latest queued value, avoiding stale render snapshots.
           *
           * @param {*} previous - Previous state used for an immutable update.
           */
          (previous) =>
            previous.map(
              /**
               * Project each previous entry for remove; preserve input ordering in the derived collection.
               *
               * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               */
              (game) => (game.id === update.game.id ? withLatestMedia(update.game) : game)
            )
        )
        if (update.warning) setWarning(update.warning)
      }
    )
    const removeMedia = window.electronAPI.onGameMediaUpdated(
      /**
       * Consume onGameMediaUpdated application payloads in removeMedia; the enclosing effect disposes the IPC subscription on unmount.
       *
       * @param {*} update - Value supplied by the enclosing operation; interpreted in this callback's local scope.
       */
      (update) => {
        mediaUpdates.current.set(update.gameId, update)
        setGames(
          /**
           * Compute removeMedia's next React state from the latest queued value, avoiding stale render snapshots.
           *
           * @param {*} previous - Previous state used for an immutable update.
           */
          (previous) =>
            previous.map(
              /**
               * Project each previous entry for removeMedia; preserve input ordering in the derived collection.
               *
               * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               */
              (game) =>
                game.gameId === update.gameId
                  ? {
                      ...game,
                      media: {
                        ...game.media,
                        music: update.media.music,
                        video: update.media.video
                      },
                      musicUrl: update.musicUrl,
                      videoUrl: update.videoUrl
                    }
                  : game
            )
        )
      }
    )
    const initialScan = setTimeout(
      /**
       * Run delayed initialScan work only after the owning debounce/wait expires; the surrounding lifecycle owns cancellation.
       */
      () => {
        void refresh(false)
      },
      0
    )
    /**
     * Release the listeners, timers, or focus ownership acquired by useGameLibrary's effect before it reruns or unmounts.
     */
    return () => {
      clearTimeout(initialScan)
      mounted.current = false
      remove()
      removeMedia()
    }
  }, [refresh, withLatestMedia])
  /**
   * Remove the deleted game and its late-media merge entry immediately after successful Main
   * cleanup.
   *
   * @param {string} gameId - Stable library/media identity; Main resolves or validates it before accessing files.
   */
  const removeFromState = useCallback((gameId) => {
    mediaUpdates.current.delete(gameId)
    setGames(
      /**
       * Compute removeFromState's next React state from the latest queued value, avoiding stale render snapshots.
       *
       * @param {*} previous - Previous state used for an immutable update.
       */
      (previous) =>
        previous.filter(
          /**
           * Retain only previous entries satisfying removeFromState's local predicate; excluded values do not reach the next stage.
           *
           * @param {*} game - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (game) => game.gameId !== gameId
        )
    )
  }, [])
  return { games, loading, error, scanning, progress, warning, refresh, removeFromState }
}
