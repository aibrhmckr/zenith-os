/* eslint-disable react/prop-types -- Internal standalone-runtime status panel. */
import { useEffect, useState } from 'react'
import { useI18n } from '../hooks/i18n'

/** RPCS3 setup actions use Main-owned paths, explicit download consent and physical rechecks. */
export default function Rpcs3Status({ status, onLaunch }) {
  const { t } = useI18n()
  const [updated, setUpdated] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [working, setWorking] = useState(false)
  const [progress, setProgress] = useState(null)
  const [confirm, setConfirm] = useState(false)
  const current = updated && updated.base === status ? updated.value : status
  const operation = progress || current?.operation
  const busy = working || !!operation
  useEffect(() => window.electronAPI.onRpcs3InstallProgress(setProgress), [])
  /** Always refresh from Main after success, cancellation or failure; never set Ready optimistically. */
  const run = async (action) => {
    setWorking(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      if (!result.canceled) {
        if (!result.success) throw Error(result.error)
        setNotice(t('saved'))
      }
    } catch (e) {
      setError(e.message || t('error'))
    } finally {
      try {
        setUpdated({ base: status, value: await window.electronAPI.getRpcs3Status() })
      } catch {
        setError(t('error'))
      }
      setWorking(false)
    }
  }
  return (
    <section data-rpcs3-status className="space-y-4">
      <p className="font-bold">
        RPCS3 ·{' '}
        <span className={current?.ready && !operation ? 'text-emerald-300' : 'text-amber-200'}>
          {t(operation ? 'working' : current?.ready ? 'ready' : 'missing')}
        </span>
      </p>
      <p>{t('rpcs3SetupHelp')}</p>
      <p>
        {t('rpcs3Executable')}: {t(current?.executableReady ? 'ready' : 'missing')}
      </p>
      <p className="break-all text-sm text-white/60">{current?.executable}</p>
      <p>
        PS3 firmware: {t(current?.firmware?.ready ? 'ready' : 'missing')}{' '}
        {current?.firmware?.version}
      </p>
      <p className="break-all text-sm text-white/60">{current?.firmware?.directory}</p>
      {current?.error && <p role="status">{t(current.error)}</p>}
      {current?.message && <p className="break-words text-amber-200">{current.message}</p>}
      {error && (
        <p role="alert" className="text-rose-200">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-emerald-300">
          {notice}
        </p>
      )}
      {operation && (
        <div role="status" aria-live="polite">
          <p>{t('rpcs3Phase_' + operation.phase)}</p>
          {operation.total > 0 && (
            <progress className="w-full" value={operation.received || 0} max={operation.total} />
          )}
        </div>
      )}
      {confirm && (
        <div className="rounded-xl border border-sky-400/40 p-4 space-y-3" data-rpcs3-consent>
          <p>{t('rpcs3DownloadConsent')}</p>
          <button
            data-rpcs3-confirm
            className="console-button"
            disabled={busy}
            onClick={() => {
              setConfirm(false)
              void run(() => window.electronAPI.downloadRpcs3(true))
            }}
          >
            {t('rpcs3Download')}
          </button>
          <button className="console-button" disabled={busy} onClick={() => setConfirm(false)}>
            {t('cancel')}
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          data-initial-focus
          data-rpcs3-refresh
          disabled={busy}
          className="console-button"
          onClick={() => run(async () => ({ success: true }))}
        >
          {t('rpcs3Recheck')}
        </button>
        {!current?.executableReady && current?.hostPlatform !== 'linux' && (
          <button
            data-rpcs3-download
            disabled={busy}
            className="console-button"
            onClick={() => setConfirm(true)}
          >
            {t('rpcs3Download')}
          </button>
        )}
        <button
          data-rpcs3-firmware
          disabled={busy || !current?.executableReady}
          className="console-button"
          onClick={() => run(() => window.electronAPI.installPs3Firmware())}
        >
          {t('rpcs3InstallFirmware')}
        </button>
        <button
          data-rpcs3-package
          disabled={busy || !current?.executableReady}
          className="console-button"
          onClick={() => run(() => window.electronAPI.installPs3Package())}
        >
          {t('rpcs3InstallPackage')}
        </button>
        <button
          className="console-button"
          disabled={busy}
          onClick={() => run(() => window.electronAPI.openRpcs3Folder())}
        >
          {t('folder')}
        </button>
        {operation && (
          <button
            data-rpcs3-cancel
            className="console-button"
            onClick={() =>
              window.electronAPI.cancelRpcs3Install().catch(() => setError(t('error')))
            }
          >
            {t('cancel')}
          </button>
        )}
        {current?.ready && onLaunch && (
          <button data-rpcs3-launch disabled={busy} className="console-button" onClick={onLaunch}>
            {t('launch')}
          </button>
        )}
      </div>
    </section>
  )
}
