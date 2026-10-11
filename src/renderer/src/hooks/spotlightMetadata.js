/** Normalize optional library metadata; missing/placeholder fields never become chips. */
export function spotlightMetadata(game) {
  const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean).filter(Boolean).join(', ')
    if (typeof value !== 'string' && typeof value !== 'number') return ''
    const text = String(value).trim()
    return /^(unknown|bilinmiyor|n\/a|null|undefined)$/i.test(text) ? '' : text
  }
  const field = (...keys) =>
    keys
      .flatMap((key) => [game.metadata?.[key], game[key]])
      .map(clean)
      .find(Boolean) || ''
  const releaseDate = field('releaseDate')
  const parsedDate = releaseDate ? new Date(releaseDate) : null
  const dateYear =
    parsedDate && Number.isFinite(parsedDate.getTime()) ? String(parsedDate.getFullYear()) : ''
  const filename = field('fileName', 'path')
  const extension = filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase()
  return {
    platform: field('systemShort', 'platform'),
    year: field('year', 'releaseYear') || dateYear,
    genre: field('genre', 'genres', 'category'),
    publisher: field('publisher', 'developer'),
    synopsis: field('synopsis', 'overview', 'description', 'plot', 'summary'),
    region: field('region') || 'PAL/NTSC',
    format: field('format') || extension || 'ISO'
  }
}
