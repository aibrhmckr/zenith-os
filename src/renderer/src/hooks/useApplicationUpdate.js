import { useEffect, useState } from 'react'

/** Read durable Main-owned OTA status, including downloads completed while Settings was closed. */
export default function useApplicationUpdate() {
  const [state, setState] = useState({ status: 'idle', ready: false })
  useEffect(() => {
    let live = true,
      received = false
    const stop = window.electronAPI.onAppUpdate((value) => {
      received = true
      if (live) setState(value)
    })
    window.electronAPI
      .getAppUpdateState()
      .then((value) => {
        if (live && !received) setState(value)
      })
      .catch(() => {
        if (live && !received) setState({ status: 'error', message: 'Update status unavailable.' })
      })
    return () => {
      live = false
      stop()
    }
  }, [])
  return state
}
