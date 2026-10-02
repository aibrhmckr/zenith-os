import { useCallback, useEffect, useRef, useState } from 'react'

// The same import/folder workflow can be reused by a future Settings screen.
/**
 * Provide the reusable BIOS dialog/import lifecycle independently of App. This legacy hook
 * remains available but the dashboard currently uses its own BIOS panel.
 *
 * @param {Function} onClose - Ask the owner to dismiss this surface and restore its prior focus.
 */
export default function useBiosManager(onClose) {
  /**
   * Selected BIOS platform, or null when the reusable upload dialog is closed.
   */
  const [platform, setPlatform] = useState(null)
  /**
   * Render-visible pending state disables dialog actions.
   */
  const [busy, setBusy] = useState(false)
  /**
   * Latest actionable upload/folder error for the dialog.
   */
  const [error, setError] = useState('')
  /**
   * Successful upload feedback retained after dismissal.
   */
  const [notice, setNotice] = useState('')
  /**
   * Native BIOS dialog ref for initial focus and restoration.
   */
  const dialogRef = useRef(null)
  /**
   * Immediate operation lock protects against repeated controller presses before a React render.
   */
  const pendingRef = useRef(false)

  /**
   * Select a BIOS platform and clear stale messages before showing its dialog.
   *
   * @param {string} system - Console ID from the shared platform registry.
   */
  const show = useCallback((system) => {
    setError('')
    setNotice('')
    setPlatform(system)
  }, [])

  /**
   * Close only when no native operation is pending and notify the owning launch flow to release
   * its UI state.
   */
  const close = useCallback(() => {
    if (pendingRef.current) return
    setPlatform(null)
    setError('')
    onClose()
  }, [onClose])

  /**
   * Open the platform dialog with upload focus and restore the prior control when it closes.
   */
  useEffect(() => {
    if (!platform) return
    const previousFocus = document.activeElement
    dialogRef.current?.showModal()
    dialogRef.current?.querySelector('[data-upload-bios]')?.focus()
    /**
     * Release the listeners, timers, or focus ownership acquired by useBiosManager's effect before it reruns or unmounts.
     */
    return () => previousFocus?.focus()
  }, [platform])

  /**
   * Serialize BIOS upload/folder IPC, distinguish cancellation from failure, and clear the busy
   * ref in finally.
   *
   * @param {Function|string} action - Asynchronous IPC action, or a BIOS operation selector in useBiosManager.
   */
  const run = async (action) => {
    if (pendingRef.current || !platform) return
    pendingRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await (action === 'upload'
        ? window.electronAPI.uploadBios(platform)
        : window.electronAPI.openBiosFolder(platform))
      if (result.canceled) return
      if (!result.success) {
        setError(result.error || 'BIOS işlemi tamamlanamadı.')
        return
      }
      if (action === 'upload') {
        setNotice(`${result.fileName} yüklendi. Oyunu şimdi başlatabilirsiniz.`)
        setPlatform(null)
        onClose()
      }
    } catch (error) {
      console.error('BIOS işlemi başarısız:', error)
      setError('BIOS işlemi tamamlanamadı. Klasör erişim izinlerini kontrol edin.')
    } finally {
      pendingRef.current = false
      setBusy(false)
    }
  }

  return {
    platform,
    dialogRef,
    busy,
    error,
    notice,
    show,
    close,
    /**
     * Run the BIOS file-picker/copy workflow for the currently selected platform.
     */
    upload: () => run('upload'),
    /**
     * Ask Main to open the currently selected BIOS destination in the file manager.
     */
    openFolder: () => run('folder'),
    /**
     * Clear the previous successful-upload message without changing BIOS data.
     */
    dismissNotice: () => setNotice('')
  }
}
