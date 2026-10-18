import HardwareStatus from './HardwareStatus'
/* eslint-disable react/prop-types -- Internal settings panel. */
import { useEffect, useState } from 'react'
import Rpcs3Status from './Rpcs3Status'
import ConsoleStatusCard, { CoreLabel } from './ConsoleStatusCard'
import HotkeySetting from './HotkeySetting'
import ConsoleDropdown from './ConsoleDropdown'
import SettingsIcon from './SettingsIcon'
import { taskError } from '../hooks/downloadPresentation'
import { useI18n } from '../hooks/i18n'
import useApplicationUpdate from '../hooks/useApplicationUpdate'
/**
 * Render language/audio/hotkey settings or the library-only core/BIOS status page. Main owns
 * filesystem operations; this component presents their live results.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {Object} options.preferences - Persistent audio flags and normalized hotkey mapping.
 * @param {Function} options.togglePreference - Toggle a known boolean setting in the parent preference hook.
 * @param {Function} options.saveHotkeys - Persist a normalized key pair through Main.
 * @param {Function} options.playSound - Play a named application sound through the shared pool.
 * @param {boolean} options.wallpaperOnly - Disable preview audio controls without overwriting the saved preference.
 * @param {boolean} options.focusUpdate - Let ConsoleModal initially focus Software Update after notification navigation.
 * @param {Array} options.updateTasks - Main-owned task snapshots used to prevent duplicate maintenance actions.
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
  wallpaperOnly = false,
  focusUpdate = false,
  updateTasks = [],
  systemPage = false,
  onOpenSystems,
  onOpenWallpapers,
  onBrowseCores,
  onDeleteBios
}) {
  const { t, language, setLanguage } = useI18n()
  const appUpdate = useApplicationUpdate()
  const appUpdating = ['checking', 'downloading'].includes(appUpdate.status)
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
  const update = updateTasks.find((task) => task.id === 'software-update')
  const updating = updateTasks.some(
    (task) => task.id === 'software-update' && task.status === 'active'
  )
  // Main owns the long-running operation; opening this page never initiates an update.
  const updateSoftware = async () => {
    if (busy || updating || appUpdating) return
    setBusy(true)
    setFailed(false)
    setMessage('')
    try {
      const result = appUpdate.ready
        ? await window.electronAPI.quitAndInstallUpdate()
        : await window.electronAPI.updateSoftware()
      if (!result.success) throw Error(result.error)
      setMessage(t(appUpdate.ready ? 'appUpdateInstalling' : 'softwareUpdateStarted'))
    } catch (error) {
      setFailed(true)
      setMessage(error.message || t('error'))
    } finally {
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
          <div className="settings-language-card">
            <span className="settings-card-icon">
              <SettingsIcon name="globe" />
            </span>
            <h3>{t('languageSelection')}</h3>
            <ConsoleDropdown
              label={t('languageSelection')}
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
                  disabled={key === 'previewSound' && wallpaperOnly}
                  aria-describedby={
                    key === 'previewSound' && wallpaperOnly ? 'wallpaper-audio-hint' : undefined
                  }
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
            {wallpaperOnly && (
              <p id="wallpaper-audio-hint" className="text-sm text-white/60">
                {t('wallpaperAudioMuted')}
              </p>
            )}
          </div>
          <h3 className="mb-3 font-bold">{t('mediaDownloads')}</h3>
          <div className="mb-8 space-y-3">
            {['downloadCovers', 'downloadBackgrounds', 'downloadVideos', 'downloadAudio'].map(
              (key) => (
                <button
                  key={key}
                  type="button"
                  role="switch"
                  aria-checked={preferences[key]}
                  data-media-setting={key}
                  disabled={busy}
                  className="settings-toggle"
                  onClick={() =>
                    run(async () => {
                      playSound('toggle')
                      await togglePreference(key)
                      return { success: true }
                    })
                  }
                >
                  <span>{t(key)}</span>
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
          <div className="settings-navigation-cards">
            <button
              data-wallpaper-page
              className="settings-navigation-card"
              onClick={onOpenWallpapers}
            >
              <span className="settings-card-icon">
                <SettingsIcon name="palette" />
              </span>
              <span className="settings-card-copy">
                <strong>{t('wallpapersTitle')}</strong>
                <span>{t('wallpapersNavHelp')}</span>
              </span>
              <span className="settings-card-chevron">
                <SettingsIcon name="chevron" />
              </span>
            </button>
            <button data-system-page className="settings-navigation-card" onClick={onOpenSystems}>
              <span className="settings-card-icon">
                <SettingsIcon name="chip" />
              </span>
              <span className="settings-card-copy">
                <strong>{t('status')}</strong>
                <span>{t('systemsNavHelp')}</span>
              </span>
              <span className="settings-card-chevron">
                <SettingsIcon name="chevron" />
              </span>
            </button>
            <button
              data-software-update
              data-settings-update-focus={focusUpdate}
              aria-disabled={busy || updating || appUpdating}
              className="settings-navigation-card"
              onClick={updateSoftware}
            >
              <span className="settings-card-icon">
                <SettingsIcon name="update" />
              </span>
              <span className="settings-card-copy">
                <strong>
                  {t(appUpdate.ready ? 'appUpdateReady' : 'softwareUpdate')}
                  {updating ? ' · ' + t('working') : ''}
                </strong>
                <span>{t(appUpdate.ready ? 'installUpdate' : 'softwareUpdateNavHelp')}</span>
                <span
                  className="settings-update-tracker"
                  data-app-update-status={appUpdate.status}
                  role="status"
                  aria-live="polite"
                >
                  {appUpdate.status === 'developer' && <span>{t('developerBuild')}</span>}
                  {appUpdate.status === 'checking' && <span>{t('appUpdateChecking')}</span>}
                  {appUpdate.status === 'up-to-date' && <span>{t('appUpdateCurrent')}</span>}
                  {appUpdate.status === 'downloading' && (
                    <>
                      <span>
                        {t('appUpdateDownloading')
                          .replace('{version}', appUpdate.version || '')
                          .replace('{percent}', Math.round(appUpdate.percent || 0))}
                      </span>
                      <progress
                        aria-label={t('appUpdateTitle')}
                        max="100"
                        value={appUpdate.percent ?? undefined}
                      />
                    </>
                  )}
                  {appUpdate.ready && (
                    <span>
                      {t('appUpdateReadyHelp').replace('{version}', appUpdate.version || '')}
                    </span>
                  )}
                  {appUpdate.status === 'error' && (
                    <span className="text-rose-200">
                      {taskError({ error: appUpdate.message }, t)}
                    </span>
                  )}
                </span>
                {update && (
                  <span
                    className="settings-update-tracker"
                    data-update-tracker
                    role="status"
                    aria-live="polite"
                  >
                    {update.developer && appUpdate.status !== 'developer' && (
                      <span>{t('developerBuild')}</span>
                    )}
                    {updating && (
                      <>
                        <span>
                          {update.component || t('working')}
                          {Number.isFinite(update.componentPercent)
                            ? ' · ' + update.componentPercent + '%'
                            : ''}
                        </span>
                        <progress
                          aria-label={t('softwareUpdate')}
                          max="100"
                          value={update.componentPercent ?? undefined}
                        />
                        <span>
                          {t('componentsUpdated')
                            .replace('{done}', update.completedComponents || 0)
                            .replace('{total}', update.totalComponents || 0)}
                        </span>
                      </>
                    )}
                    {update.status === 'completed' && (
                      <span>
                        {t(
                          update.phase === 'ready-to-install'
                            ? 'appUpdateReady'
                            : 'softwareUpdateComplete'
                        )}
                      </span>
                    )}
                    {update.status === 'failed' && (
                      <span className="text-rose-200">{taskError(update, t)}</span>
                    )}
                  </span>
                )}
              </span>
              <span className="settings-card-chevron">
                <SettingsIcon name="chevron" />
              </span>
            </button>
          </div>
        </>
      )}
      {systemPage && (
        <>
          <HardwareStatus />
          <div className="system-status-list">
            {!systems.length && <p>{t('noSystems')}</p>}
            {systems.map(
              /**
               * Project each systems entry for SystemSettings; preserve input ordering in the derived collection.
               *
               * @param {*} system - Value supplied by the enclosing operation; interpreted in this callback's local scope.
               */
              (system) =>
                system.emulator === 'RPCS3' ? (
                  <div
                    key={system.platform}
                    data-core-platform="PS3"
                    className="system-status-slot"
                  >
                    <Rpcs3Status status={system.runtime} />
                  </div>
                ) : (
                  <div
                    key={system.platform}
                    data-core-platform={system.platform}
                    className="system-status-slot"
                  >
                    <ConsoleStatusCard
                      platform={system.platform}
                      emulator={<CoreLabel file={system.core || system.expectedCore} />}
                      ready={!!system.core && system.bios.ready}
                      details={
                        <>
                          <p>
                            {t('core')}: {system.core || t('missing')}
                          </p>
                          <code>{system.corePath || system.coreDirectory}</code>
                          {system.bios.required && (
                            <p>
                              BIOS:{' '}
                              {system.bios.ready ? t('ready') : system.bios.missing.join(', ')}
                            </p>
                          )}
                        </>
                      }
                    >
                      <div className="system-status-actions">
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
                    </ConsoleStatusCard>
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
