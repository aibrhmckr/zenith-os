import { normalizeHotkeys } from '../../../shared/hotkeys'
import { useCallback, useEffect, useState } from 'react'

const DEFAULTS = { menuSounds: true, previewSound: false }
export default function usePreferences() {
  const [preferences, setPreferences] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('zenith-preferences')) || {}
      return {
        hotkeys: normalizeHotkeys(saved.hotkeys),
        ...Object.fromEntries(
          Object.entries(DEFAULTS).map(([key, value]) => [
            key,
            typeof saved[key] === 'boolean' ? saved[key] : value
          ])
        )
      }
    } catch {
      return { ...DEFAULTS, hotkeys: normalizeHotkeys(null) }
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('zenith-preferences', JSON.stringify(preferences))
    } catch {
      /* Keep the current session usable if storage is unavailable. */
    }
  }, [preferences])
  useEffect(() => {
    let active = true
    void window.electronAPI
      .getHotkeys()
      .then((hotkeys) => {
        if (active)
          setPreferences((current) => ({ ...current, hotkeys: normalizeHotkeys(hotkeys) }))
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  const saveHotkeys = useCallback(async (hotkeys) => {
    const result = await window.electronAPI.saveHotkeys(normalizeHotkeys(hotkeys))
    if (!result.success) throw Error(result.error)
    setPreferences((current) => ({ ...current, hotkeys: result.hotkeys }))
  }, [])
  const togglePreference = useCallback((key) => {
    if (Object.hasOwn(DEFAULTS, key))
      setPreferences((current) => ({ ...current, [key]: !current[key] }))
  }, [])
  return { preferences, togglePreference, saveHotkeys }
}
