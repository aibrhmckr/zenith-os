import { useCallback, useEffect, useRef, useState } from 'react'

// The same import/folder workflow can be reused by a future Settings screen.
export default function useBiosManager(onClose) {
  const [platform, setPlatform] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const dialogRef = useRef(null)
  const pendingRef = useRef(false)

  const show = useCallback((system) => {
    setError('')
    setNotice('')
    setPlatform(system)
  }, [])

  const close = useCallback(() => {
    if (pendingRef.current) return
    setPlatform(null)
    setError('')
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!platform) return
    const previousFocus = document.activeElement
    dialogRef.current?.showModal()
    dialogRef.current?.querySelector('[data-upload-bios]')?.focus()
    return () => previousFocus?.focus()
  }, [platform])

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
    upload: () => run('upload'),
    openFolder: () => run('folder'),
    dismissNotice: () => setNotice('')
  }
}
