/* eslint-disable react/prop-types -- Internal standalone-runtime status panel. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../hooks/i18n'
import useFilePicker from '../hooks/useFilePicker'
import ConsoleStatusCard from './ConsoleStatusCard'

/** RPCS3 setup actions use Main-owned paths, explicit download consent and physical rechecks. */
export default function Rpcs3Status({ status, onLaunch }) {
  const { t } = useI18n()
  const filePicker = useFilePicker()
  const panel = useRef(null)
  const returnFocus = useRef(null)
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
  // The picker closes while its launch button is disabled. Restore after React re-enables it.
  useLayoutEffect(() => {
    if (busy || !returnFocus.current) return
    const target = returnFocus.current
    returnFocus.current = null
    if (target.isConnected && !target.disabled) {
      target.focus({ preventScroll: true })
      target.dataset.controllerFocused = 'true'
    }
  }, [busy])
  const pickContent = async (kind) => {
    returnFocus.current = panel.current?.querySelector(`[data-rpcs3-${kind}]`)
    const tokens = await filePicker.pick(kind)
    if (!tokens) return { canceled: true }
    return kind === 'firmware'
      ? window.electronAPI.installPs3Firmware(tokens[0])
      : window.electronAPI.installPs3Package(tokens[0])
  }
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
    <section ref={panel} data-rpcs3-status className="system-status-slot">
      <ConsoleStatusCard
        platform="PS3"
        emulator="RPCS3"
        version={current?.installedVersion}
        ready={current?.ready}
        working={!!operation}
        details={
          <>
            <p>
              {t('rpcs3Executable')}: {t(current?.executableReady ? 'ready' : 'missing')}
            </p>
            <code>{current?.executable}</code>
            <p>
              PS3 firmware: {t(current?.firmware?.ready ? 'ready' : 'missing')}{' '}
              {current?.firmware?.version}
            </p>
            <code>{current?.firmware?.directory}</code>
            {current?.message && <p>{current.message}</p>}
          </>
        }
      >
        {current?.error && <p role="status">{t(current.error)}</p>}
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
        <div className="system-status-actions" data-rpcs3-actions>
          <button
            data-initial-focus
            data-rpcs3-refresh
            disabled={busy}
            className="console-button"
            onClick={() => run(async () => ({ success: true }))}
          >
            {t('rpcs3Recheck')}
          </button>
          <button
            data-rpcs3-firmware
            disabled={busy || !current?.executableReady}
            className="console-button"
            onClick={() => run(() => pickContent('firmware'))}
          >
            {t('rpcs3InstallFirmware')}
          </button>
          <button
            data-rpcs3-package
            disabled={busy || !current?.executableReady}
            className="console-button"
            onClick={() => run(() => pickContent('package'))}
          >
            {t('rpcs3InstallPackage')}
          </button>
          <button
            data-rpcs3-folder
            className="console-button"
            disabled={busy}
            onClick={() => run(() => window.electronAPI.openRpcs3Folder())}
          >
            {t('folder')}
          </button>
        </div>
        <div className="system-status-secondary">
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
      </ConsoleStatusCard>
      {filePicker.browser}
    </section>
  )
}
