import { normalizeHotkeys } from '../../../shared/hotkeys'
import { useCallback, useEffect, useState } from 'react'

/**
 * Allowed persisted boolean settings and defaults: menu effects on, preview audio off.
 */
const DEFAULTS = { menuSounds: true, previewSound: false }
/**
 * Persist renderer audio preferences locally and reconcile hotkeys with Main's userData file,
 * which is also read by the native bridge.
 */
export default function usePreferences() {
  /**
   * Validated local preferences plus normalized hotkeys; malformed storage falls back to defaults.
   */
  const [preferences, setPreferences] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('zenith-preferences')) || {}
      return {
        hotkeys: normalizeHotkeys(saved.hotkeys),
        ...Object.fromEntries(
          Object.entries(DEFAULTS).map(
            /**
             * Project each Object.entries(DEFAULTS) entry for usePreferences; preserve input ordering in the derived collection.
             *
             * @param {*} input1 - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             */
            ([key, value]) => [key, typeof saved[key] === 'boolean' ? saved[key] : value]
          )
        )
      }
    } catch {
      return { ...DEFAULTS, hotkeys: normalizeHotkeys(null) }
    }
  })
  /**
   * Persist validated renderer preferences; a storage failure must not disable the current
   * session.
   */
  useEffect(() => {
    try {
      localStorage.setItem('zenith-preferences', JSON.stringify(preferences))
    } catch {
      /* Keep the current session usable if storage is unavailable. */
    }
  }, [preferences])
  /**
   * Reconcile local hotkeys with Main persistence and ignore a response received after unmount.
   */
  useEffect(() => {
    let active = true
    void window.electronAPI
      .getHotkeys()
      .then(
        /**
         * Continue usePreferences after the preceding asynchronous stage resolves; the returned value or Promise feeds the same chain.
         *
         * @param {*} hotkeys - Value supplied by the enclosing operation; interpreted in this callback's local scope.
         */
        (hotkeys) => {
          if (active)
            setPreferences(
              /**
               * Compute usePreferences's next React state from the latest queued value, avoiding stale render snapshots.
               *
               * @param {*} current - Latest queued state or collection entry.
               */
              (current) => ({ ...current, hotkeys: normalizeHotkeys(hotkeys) })
            )
        }
      )
      .catch(
        /**
         * Handle the rejected stage of usePreferences here so its failure follows this operation's fallback/error policy.
         */
        () => {}
      )
    /**
     * Release the listeners, timers, or focus ownership acquired by usePreferences's effect before it reruns or unmounts.
     */
    return () => {
      active = false
    }
  }, [])
  /**
   * Persist a normalized pair through Main before updating local state; reject unsuccessful IPC
   * responses for the editor to display.
   *
   * @param {Object} hotkeys - Normalized gamepad indices and physical keyboard-code pair.
   */
  const saveHotkeys = useCallback(async (hotkeys) => {
    const result = await window.electronAPI.saveHotkeys(normalizeHotkeys(hotkeys))
    if (!result.success) throw Error(result.error)
    setPreferences(
      /**
       * Compute saveHotkeys's next React state from the latest queued value, avoiding stale render snapshots.
       *
       * @param {*} current - Latest queued state or collection entry.
       */
      (current) => ({ ...current, hotkeys: result.hotkeys })
    )
  }, [])
  /**
   * Toggle only a known boolean preference; persistence is handled by the owning effect.
   *
   * @param {string|number} key - Action/cache/preference key or input code used by this operation.
   */
  const togglePreference = useCallback((key) => {
    if (Object.hasOwn(DEFAULTS, key))
      setPreferences(
        /**
         * Compute togglePreference's next React state from the latest queued value, avoiding stale render snapshots.
         *
         * @param {*} current - Latest queued state or collection entry.
         */
        (current) => ({ ...current, [key]: !current[key] })
      )
  }, [])
  return { preferences, togglePreference, saveHotkeys }
}
