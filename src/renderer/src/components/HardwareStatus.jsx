import { useEffect, useState } from 'react'
import { useI18n } from '../hooks/i18n'

/** Display Main's GPU snapshot; never infer hardware capability from a renderer WebGL context. */
export default function HardwareStatus() {
  const { t } = useI18n()
  const [hardware, setHardware] = useState(null)
  useEffect(() => {
    let mounted = true
    const update = (value) => {
      if (mounted) setHardware(value)
    }
    const unsubscribe = window.electronAPI.onHardwareChanged?.(update)
    const refresh = () =>
      window.electronAPI
        .getHardwareStatus?.()
        .then(update)
        .catch(() => update({ unavailable: true }))
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      mounted = false
      unsubscribe?.()
      window.removeEventListener('focus', refresh)
    }
  }, [])
  return (
    <section
      data-hardware-status
      className="mb-5 rounded-xl border border-white/15 bg-white/5 p-4"
      aria-live="polite"
    >
      <h3 className="font-semibold">{t('hardwareTitle')}</h3>
      <p className="mt-2 text-cyan-200">
        {t(
          !hardware
            ? 'hardwareChecking'
            : hardware.unavailable || !hardware.detected
              ? 'hardwareUnknown'
              : hardware.classification === 'dedicated'
                ? 'hardwareDedicated'
                : 'hardwareFallback'
        )}
      </p>
      <ul className="mt-2 text-sm text-white/70">
        {hardware?.devices?.map((device, index) => (
          <li key={index}>
            {device.name} · {device.active ? t('hardwareActive') : t('hardwareAvailable')}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-white/60">{t('hardwareProfileHelp')}</p>
    </section>
  )
}
