/* eslint-disable react/prop-types -- Internal settings panel. */
import { useEffect, useState } from 'react'
import HotkeySetting from './HotkeySetting'
import ConsoleDropdown from './ConsoleDropdown'
import { useI18n } from '../hooks/i18n'
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
  const [systems, setSystems] = useState([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const load = () => window.electronAPI.getSystemStatus().then(setSystems)
  useEffect(() => {
    void load().catch(() => setMessage('System status unavailable.'))
  }, [])
  const run = async (action) => {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      const result = await action()
      if (result.canceled) return
      if (!result.success) throw Error(result.error)
      setMessage(result.status && !result.status.ready ? t('biosNotReady') : t('saved'))
      await load()
    } catch (error) {
      setMessage(error.message || t('error'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {message && (
        <p role="status" className="mb-4 text-sky-200">
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
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="switch"
                aria-checked={preferences[key]}
                data-audio-setting={key}
                className="settings-toggle"
                onClick={() => {
                  if (key !== 'menuSounds' || preferences.menuSounds) playSound('toggle')
                  togglePreference(key)
                }}
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
            ))}
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
            {systems.map((system) => (
              <div key={system.platform} className="rounded-xl border border-white/10 p-4">
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
                <div className="flex flex-wrap gap-2">
                  {!system.core && (
                    <button
                      disabled={busy}
                      className="console-button"
                      onClick={() => run(() => window.electronAPI.installCore(system.platform))}
                    >
                      {t('install')}
                    </button>
                  )}
                  <button
                    data-browse-cores={system.platform}
                    disabled={busy}
                    className="console-button"
                    onClick={() => onBrowseCores(system.platform)}
                  >
                    {t('browseCores')}
                  </button>
                  {system.bios.required && system.bios.ready && (
                    <button
                      data-delete-bios={system.platform}
                      disabled={busy}
                      className="console-button text-rose-200"
                      onClick={() => onDeleteBios(system.platform)}
                    >
                      {t('deleteBios')}
                    </button>
                  )}
                  {system.bios.required && (
                    <button
                      disabled={busy}
                      className="console-button"
                      onClick={() => run(() => window.electronAPI.uploadBios(system.platform))}
                    >
                      {t('uploadBios')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
