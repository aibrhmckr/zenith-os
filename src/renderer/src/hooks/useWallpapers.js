import { useEffect, useRef, useState } from 'react'
import { BUILTIN_WALLPAPERS, DEFAULT_WALLPAPER } from '../../../shared/wallpapers'

/** Main owns media and persisted preferences; serialize UI actions and ignore stale startup reads. */
export default function useWallpapers(pickFiles) {
  const [state, setState] = useState({
    items: BUILTIN_WALLPAPERS,
    selectedId: DEFAULT_WALLPAPER,
    onlyCustom: false
  })
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const pending = useRef(false),
    revision = useRef(0)
  useEffect(() => {
    let live = true
    const initial = revision.current
    window.electronAPI
      .getWallpapers()
      .then((value) => {
        if (live && initial === revision.current) setState(value)
      })
      .catch((failure) => {
        if (live) setError(failure.message)
      })
    return () => {
      live = false
    }
  }, [])
  const run = async (action) => {
    if (pending.current) return
    pending.current = true
    revision.current++
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (result.canceled) return
      if (!result.success) throw Error(result.error)
      setState(result.wallpapers)
      return true
    } catch (failure) {
      setError(failure.message)
      // Bulk deletion can partly succeed (for example, one video is locked).
      await window.electronAPI
        .getWallpapers()
        .then(setState)
        .catch(() => {})
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return {
    ...state,
    busy,
    error,
    selected: state.items.find((item) => item.id === state.selectedId) || BUILTIN_WALLPAPERS[3],
    select: (id) => run(() => window.electronAPI.saveWallpaper({ selectedId: id })),
    toggle: () => run(() => window.electronAPI.saveWallpaper({ onlyCustom: !state.onlyCustom })),
    importFile: () =>
      run(async () => {
        const tokens = await pickFiles('wallpaper')
        return tokens ? window.electronAPI.importWallpaper(tokens[0]) : { canceled: true }
      }),
    remove: (id) => run(() => window.electronAPI.deleteWallpaper({ id, confirmed: true })),
    removeSelected: (ids) =>
      run(() => window.electronAPI.deleteWallpaper({ ids, confirmed: true })),
    clearAll: () => run(() => window.electronAPI.deleteWallpaper({ all: true, confirmed: true }))
  }
}
