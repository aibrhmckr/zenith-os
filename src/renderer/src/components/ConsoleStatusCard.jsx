/* eslint-disable react/prop-types -- Shared system-status presentation. */
import { useId, useState } from 'react'
import { useI18n } from '../hooks/i18n'
import ConsoleIcon from './ConsoleIcon'

const names = {
  PS1: 'PlayStation',
  PS2: 'PlayStation 2',
  PS3: 'PlayStation 3',
  PSP: 'PlayStation Portable',
  NDS: 'Nintendo DS',
  GBA: 'Game Boy Advance',
  GBC: 'Game Boy Color',
  GameCube: 'Nintendo GameCube',
  Wii: 'Nintendo Wii',
  N64: 'Nintendo 64',
  SNES: 'Super Nintendo',
  NES: 'Nintendo Entertainment System',
  '3DS': 'Nintendo 3DS',
  Genesis: 'Sega Genesis',
  Dreamcast: 'Sega Dreamcast'
}
const coreNames = {
  pcsx2: 'PCSX2',
  lrps2: 'LRPS2',
  duckstation: 'DuckStation',
  swanstation: 'SwanStation',
  mednafen_psx_hw: 'Beetle PSX HW',
  ppsspp: 'PPSSPP',
  melonds: 'melonDS',
  mupen64plus_next: 'Mupen64Plus Next',
  mgba: 'mGBA',
  snes9x: 'Snes9x',
  mesen: 'Mesen',
  genesis_plus_gx: 'Genesis Plus GX',
  flycast: 'Flycast',
  gambatte: 'Gambatte',
  dolphin: 'Dolphin',
  citra: 'Citra',
  stella: 'Stella',
  prosystem: 'ProSystem',
  mednafen_lynx: 'Beetle Lynx'
}

/** Friendly binary labels; versions are never inferred from a platform or filename. */
export function CoreLabel({ file }) {
  if (!file) return 'Libretro'
  const name = file
    .split(/[\\/]/)
    .at(-1)
    .replace(/_libretro\.(dll|so|dylib)$/i, '')
  return `${coreNames[name] || name.replaceAll('_', ' ')} · Libretro`
}

/** Uniform header/actions; technical paths stay unmounted until explicitly requested. */
export default function ConsoleStatusCard({
  platform,
  emulator,
  version,
  ready,
  working,
  details,
  children
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  return (
    <section className="system-status-card" data-status-card={platform}>
      <header className="system-status-heading">
        <span className="system-status-icon">
          <ConsoleIcon platform={platform} />
        </span>
        <div className="system-status-identity">
          <h3>{names[platform] || (platform === 'Unassigned' ? t('unknown') : platform)}</h3>
          <p>
            {emulator}
            {version ? ` · ${version}` : ''}
          </p>
        </div>
        <span className="system-status-badge" data-ready={!!ready && !working}>
          {t(working ? 'working' : ready ? 'ready' : 'missing')}
        </span>
      </header>
      <div className="system-status-body">{children}</div>
      <button
        className="system-status-details-toggle"
        data-status-details-toggle
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded(!expanded)}
      >
        {t(expanded ? 'hideDetails' : 'showDetails')}{' '}
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div id={detailsId} className="system-status-details" data-status-details>
          {details}
        </div>
      )}
    </section>
  )
}
