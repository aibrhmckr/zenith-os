import { useRef, useState } from 'react'
import FileBrowser from '../components/FileBrowser'

/** A modal promise shared by import callers; no OS picker or renderer filesystem access. */
export default function useFilePicker() {
  const [kind, setKind] = useState(null)
  const pending = useRef(null)
  const pick = (purpose) =>
    new Promise((resolve) => {
      pending.current?.(null)
      pending.current = resolve
      setKind(purpose)
    })
  const finish = (tokens) => {
    pending.current?.(tokens)
    pending.current = null
    setKind(null)
  }
  return { pick, browser: kind && <FileBrowser kind={kind} onFinish={finish} /> }
}
