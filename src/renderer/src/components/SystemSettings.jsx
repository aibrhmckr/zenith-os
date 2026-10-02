/* eslint-disable react/prop-types -- Internal settings panel. */
import { useEffect, useState } from 'react'
import HotkeySetting from './HotkeySetting'
import ConsoleDropdown from './ConsoleDropdown'
import { useI18n } from '../hooks/i18n'
/**
 * Render language/audio/hotkey settings or the library-only core/BIOS status page. Main owns
 * filesystem operations; this component presents their live results.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {Object} options.preferences - Persistent audio flags and normalized hotkey mapping.
 * @param {Function} options.togglePreference - Toggle a known boolean setting in the parent preference hook.
 * @param {Function} options.saveHotkeys - Persist a normalized key pair through Main.
 * @param {Function} options.playSound - Play a named application sound through the shared pool.
 * @param {boolean} options.systemPage - Show core/BIOS status instead of general Settings.
 * @param {Function} options.onOpenSystems - Navigate to the system-status subpage.
 * @param {Function} options.onBrowseCores - Open the core catalog for the selected platform.
 * @param {Function} options.onDeleteBios - Open parent-owned BIOS deletion confirmation.
 */
export default function SystemSettings({
  preferences,
  togglePreference,
  saveHotkeys,
  playSound,
  systemPage = false,
  onOpenSystems,
  onBrowseCores,
  onDeleteBios
}) {
  const { t, language, setLanguage } = useI18n()
  /**
   * Physical core/BIOS status plus operation busy/error/message state; Ready is recomputed by Main
   * rather than set optimistically.
   */
  const [systems, setSystems] = useState([]),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [message, setMessage] = useState('')
  /**
   * Reload physical core/BIOS status after an operation so Ready never relies on a UI-only
   * installed flag.
   */
  const load = () => window.electronAPI.getSystemStatus().then(setSystems)
  /**
   * Read physical system status on mount, every two seconds, and on window focus; stop polling and
   * ignore late responses on unmount.
   */
  useEffect(() => {
    let active = true
    /**
     * Poll Main while mounted and on focus; convert IPC failures into a visible status error and
     * discard stale unmounted responses.
     */
    const refresh = async () => {
      try {
        const status = await window.electronAPI.getSystemStatus()
        if (active) setSystems(status)
      } catch {
        if (active) {
          setSystems([])
          setFailed(true)
          setMessage('System status unavailable.')
        }
      }
    }
    void refresh()
    const timer = setInterval(refresh, 2000)
    window.addEventListener('focus', refresh)
    /**
     * Release the listeners, timers, or focus ownership acquired by SystemSettings's effect before it reruns or unmounts.
     */
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  /**
   * Lock settings actions during an IPC operation, show its result, and recheck disk status even
   * after failure or cancellation.
   *
   * @param {Function|string} action - Asynchronous IPC action, or a BIOS operation selector in useBiosManager.
   */
  const run = async (action) => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    setMessage('')
    try {
      const result = await action()
      if (result.canceled) return
      if (!result.success) throw Error(result.error)
      setMessage(result.status && !result.status.ready ? t('biosNotReady') : t('saved'))
    } catch (error) {
      setFailed(true)
      setMessage(error.message || t('error'))
    } finally {
      try {
        await load()
      } catch {
        setSystems([])
        setFailed(true)
        setMessage('System status unavailable.')
      }
      setBusy(false)
    }
  }
  return (
    <>
      {message && (
        <p
          role={failed ? 'alert' : 'status'}
          className={`mb-4 break-words ${failed ? 'text-rose-300' : 'text-sky-200'}`}
        >
          {message}
        </p>
      )}
      {busy && <p className="animate-pulse">{t('working')}</p>}
      {!systemPage && (
        <>
          <h3 className="mb-3 font-bold">{t('language')}</h3>
          <div className="mb-7 max-w-sm">
            <ConsoleDropdown
              label={t('language')}
              value={language}
              onChange={setLanguage}
              options={[
                { value: 'en', label: 'English' },
                { value: 'tr', label: 'Türkçe' }
              ]}
            />
          </div>
          <h3 className="mb-3 font-bold">{t('audioSettings')}</h3>
          <div className="mb-8 space-y-3">
            {[
              ['menuSounds', 'sfx'],
              ['previewSound', 'previewAudio']
            ].map(
              /**
               * Project each [ ['menuSounds', 'sfx'], ['previewSound', 'previewAudio'] ] entry for SystemSettings; preserve input ordering in the derived collection.
               *
               * @param {*} input1 - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               */
              ([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="switch"
                  aria-checked={preferences[key]}
                  data-audio-setting={key}
                  className="settings-toggle"
                  onClick={
                    /**
                     * Handle onClick on this SystemSettings control using the current render's values; delegate state/IPC work to its owning component.
                     */
                    () => {
                      if (key !== 'menuSounds' || preferences.menuSounds) playSound('toggle')
                      togglePreference(key)
                    }
                  }
                >
                  <span>{t(label)}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-white/65">
                      {t(preferences[key] ? 'on' : 'off')}
                    </span>
                    <span className="toggle-track" aria-hidden="true">
                      <span />
                    </span>
                  </span>
                </button>
              )
            )}
          </div>
          <HotkeySetting hotkeys={preferences.hotkeys} onSave={saveHotkeys} />
          <button data-system-page className="console-button w-full" onClick={onOpenSystems}>
            {t('status')} →
          </button>
        </>
      )}
      {systemPage && (
        <>
          <div className="space-y-3">
            {!systems.length && <p>{t('noSystems')}</p>}
            {systems.map(
              /**
               * Project each systems entry for SystemSettings; preserve input ordering in the derived collection.
               *
               * @param {*} system - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               */
              (system) => (
                <div
                  key={system.platform}
                  data-core-platform={system.platform}
                  className="rounded-xl border border-white/10 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <strong>{system.platform}</strong>
                    <span
                      className={
                        system.core && system.bios.ready ? 'text-emerald-300' : 'text-amber-200'
                      }
                    >
                      {t(system.core && system.bios.ready ? 'ready' : 'missing')}
                    </span>
                  </div>
                  <p className="my-2 text-xs text-white/50">
                    {t('core')}: {system.core || t('missing')}
                    {system.bios.required
                      ? ' · BIOS: ' +
                        (system.bios.ready ? t('ready') : system.bios.missing.join(', '))
                      : ''}
                  </p>
                  <p className="mb-3 break-all text-xs text-white/50">
                    {system.corePath || system.coreDirectory}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {!system.core && (
                      <button
                        data-install-core={system.platform}
                        disabled={busy}
                        className="console-button"
                        onClick={
                          /**
                           * Handle onClick on this SystemSettings control using the current render's values; delegate state/IPC work to its owning component.
                           */
                          () =>
                            run(
                              /**
                               * Perform one SystemSettings operation or its success continuation under the parent's busy/error handling.
                               */
                              () => window.electronAPI.installCore(system.platform)
                            )
                        }
                      >
                        {t('install')}
                      </button>
                    )}
                    <button
                      data-browse-cores={system.platform}
                      disabled={busy}
                      className="console-button"
                      onClick={
                        /**
                         * Handle onClick on this SystemSettings control using the current render's values; delegate state/IPC work to its owning component.
                         */
                        () => onBrowseCores(system.platform)
                      }
                    >
                      {t('browseCores')}
                    </button>
                    {system.bios.required && system.bios.ready && (
                      <button
                        data-delete-bios={system.platform}
                        disabled={busy}
                        className="console-button text-rose-200"
                        onClick={
                          /**
                           * Handle onClick on this SystemSettings control using the current render's values; delegate state/IPC work to its owning component.
                           */
                          () => onDeleteBios(system.platform)
                        }
                      >
                        {t('deleteBios')}
                      </button>
                    )}
                    {system.bios.required && (
                      <button
                        disabled={busy}
                        className="console-button"
                        onClick={
                          /**
                           * Handle onClick on this SystemSettings control using the current render's values; delegate state/IPC work to its owning component.
                           */
                          () =>
                            run(
                              /**
                               * Perform one SystemSettings operation or its success continuation under the parent's busy/error handling.
                               */
                              () => window.electronAPI.uploadBios(system.platform)
                            )
                        }
                      >
                        {t('uploadBios')}
                      </button>
                    )}
                  </div>
                </div>
              )
            )}
          </div>
        </>
      )}
      <footer
        data-legal-notice
        className="mt-6 border-t border-white/10 pt-4 text-sm text-white/70"
      >
        Zenith OS does not bundle ROMs or BIOS files. RetroArch is licensed under GNU GPL v3.
      </footer>
    </>
  )
}
