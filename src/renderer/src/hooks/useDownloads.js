import { useEffect, useState } from 'react'
/** Subscribe before the snapshot read so a late snapshot cannot erase fresher task progress. */
export default function useDownloads() {
  const [tasks, setTasks] = useState([])
  useEffect(() => {
    let live = true,
      received = false
    const stop = window.electronAPI.onDownloadsProgress((value) => {
      received = true
      if (live) setTasks(value)
    })
    window.electronAPI
      .getDownloads()
      .then((value) => {
        if (live && !received) setTasks(value)
      })
      .catch(() => {})
    return () => {
      live = false
      stop()
    }
  }, [])
  return tasks
}
