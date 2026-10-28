/* eslint-disable react/prop-types -- Read-only library presentation. */
import { useEffect, useState } from 'react'
import ConsoleIcon from './ConsoleIcon'
import { spotlightMetadata } from '../hooks/spotlightMetadata'

/** Render verified metadata only; a failed ClearLogo immediately falls back to the title. */
export default function GameSpotlight({ activeGame }) {
  const game = activeGame
  const [failedLogos, setFailedLogos] = useState([])
  useEffect(() => {
    if (import.meta.env.DEV && localStorage.getItem('zenith-debug') === 'true')
      console.log('[GameSpotlight Data]:', activeGame)
  }, [activeGame])
  const logo = [game.logoUrl, game.clearLogo, game.logoPath].find(
    (value) => typeof value === 'string' && value.trim() && !failedLogos.includes(value)
  )
  const metadata = spotlightMetadata(game)
  const chips = ['year', 'genre', 'publisher'].filter((name) => metadata[name])
  if (chips.length < 3) chips.push('region', 'format')
  const { synopsis } = metadata
  return (
    <div className="game-spotlight" data-game-spotlight key={game.id}>
      {logo ? (
        <img
          className="spotlight-logo"
          src={logo}
          alt={game.title}
          onError={() => setFailedLogos((previous) => [...previous, logo])}
        />
      ) : (
        <h1>{game.title}</h1>
      )}
      <div className="spotlight-chips">
        <span className="spotlight-platform">
          <ConsoleIcon platform={metadata.platform} />
          {metadata.platform}
        </span>
        {chips.map((name) => (
          <span key={name} data-spotlight-chip={name}>
            {metadata[name]}
          </span>
        ))}
      </div>
      {synopsis && <p className="spotlight-synopsis">{synopsis}</p>}
    </div>
  )
}
