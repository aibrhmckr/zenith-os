/** Main and renderer share the four independent, enabled-by-default download permissions. */
export const MEDIA_DEFAULTS = {
  downloadCovers: true,
  downloadBackgrounds: true,
  downloadVideos: true,
  downloadAudio: true
}

/** Preserve explicitly disabled legacy preferences when upgrading an existing profile. */
export function mediaPreferences(value) {
  const legacy = {
    downloadCovers: value?.onlineImages,
    downloadBackgrounds: value?.onlineImages,
    downloadVideos: value?.onlineVideos
  }
  return Object.fromEntries(
    Object.entries(MEDIA_DEFAULTS).map(([key, fallback]) => [
      key,
      typeof value?.[key] === 'boolean'
        ? value[key]
        : typeof legacy[key] === 'boolean'
          ? legacy[key]
          : fallback
    ])
  )
}
