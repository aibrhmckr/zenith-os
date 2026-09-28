import { useEffect, useState } from 'react'

export default function useGridColumns(ref) {
  const [columns, setColumns] = useState(1)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const tracks = getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean)
      setColumns(tracks[0] === 'none' ? 1 : tracks.length || 1)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [ref])
  return columns
}
