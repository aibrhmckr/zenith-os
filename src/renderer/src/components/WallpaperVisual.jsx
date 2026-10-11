/* eslint-disable react/prop-types -- Main-validated wallpaper descriptor. */
import { useEffect, useRef, useState } from 'react'
import LuminescentGlade from './LuminescentGlade'

/** Procedural themes and always-muted local videos; background players pause when obscured/hidden. */
export default function WallpaperVisual({ wallpaper, playing = false }) {
  const video = useRef(null)
  const [failedUrl, setFailedUrl] = useState(null)
  const failed = wallpaper.url && wallpaper.url === failedUrl
  useEffect(() => {
    const player = video.current
    if (!player) return
    const sync = () => {
      player.muted = true
      player.volume = 0
      if (playing && !document.hidden) void player.play().catch(() => {})
      else player.pause()
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      player.pause()
      document.removeEventListener('visibilitychange', sync)
    }
  }, [playing, wallpaper.url, failed])
  if (wallpaper.type === 'theme' || failed)
    return (
      <div
        aria-hidden="true"
        className={'wallpaper-theme theme-' + (failed ? 'minimal-dark' : wallpaper.id)}
        data-animated={playing}
      >
        <i />
        <i />
        <i />
        {wallpaper.id === 'luminescent-glade' && !failed && <LuminescentGlade />}
      </div>
    )
  if (wallpaper.type === 'video')
    return (
      <video
        ref={video}
        src={wallpaper.url}
        muted
        loop
        playsInline
        preload="metadata"
        aria-hidden="true"
        onError={() => setFailedUrl(wallpaper.url)}
      />
    )
  return <img src={wallpaper.url} alt="" onError={() => setFailedUrl(wallpaper.url)} />
}
