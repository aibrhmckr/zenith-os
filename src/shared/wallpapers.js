/** Original procedural themes: no downloaded artwork or licensed game assets. */
export const BUILTIN_WALLPAPERS = [
  { id: 'retro-grid', name: 'Retro Grid / Synthwave', type: 'theme' },
  { id: 'deep-space', name: 'Deep Space Console', type: 'theme' },
  { id: 'pixel-nebula', name: 'Pixel Nebula', type: 'theme' },
  { id: 'minimal-dark', name: 'Zenith Minimal Dark', type: 'theme' },
  { id: 'luminescent-glade', name: 'Luminescent Glade', type: 'theme' }
]
export const DEFAULT_WALLPAPER = 'minimal-dark'

/** Pure media priority rule; a failed game asset leaves the wallpaper visible beneath it. */
export function wallpaperGameMedia(game, onlyCustom, failed = {}) {
  return {
    image: !onlyCustom && game?.backdropUrl !== failed.image ? game?.backdropUrl || null : null,
    video: !onlyCustom && game?.videoUrl !== failed.video ? game?.videoUrl || null : null
  }
}
