import { useEffect, useState } from 'react'

/**
 * Measure actual CSS grid tracks with ResizeObserver so keyboard/gamepad movement follows
 * responsive columns rather than a fixed count.
 *
 * @param {Object} ref - React ref to the rendered grid element to measure.
 */
export default function useGridColumns(ref) {
  /**
   * Measured CSS track count; fallback one keeps navigation valid before layout.
   */
  const [columns, setColumns] = useState(1)
  /**
   * Observe actual grid size and recalculate tracks after responsive changes; disconnect the
   * observer on cleanup.
   */
  useEffect(() => {
    const element = ref.current
    if (!element) return
    /**
     * Count computed grid tracks after layout, falling back to one column before CSS has established
     * a grid.
     */
    const measure = () => {
      const tracks = getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean)
      setColumns(tracks[0] === 'none' ? 1 : tracks.length || 1)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    /**
     * Release the listeners, timers, or focus ownership acquired by useGridColumns's effect before it reruns or unmounts.
     */
    return () => observer.disconnect()
  }, [ref])
  return columns
}
