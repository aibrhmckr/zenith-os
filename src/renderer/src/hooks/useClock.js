import { useEffect, useState } from 'react'

/**
 * Read local system time in fixed 24-hour HH:mm form; no network clock or hardcoded display
 * value is used.
 */
const readClock = () =>
  new Date().toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })

/**
 * Refresh local time once per second and release the interval on unmount.
 */
export default function useClock() {
  /**
   * Local HH:mm display value; updated every second to align with the system clock.
   */
  const [time, setTime] = useState(readClock)
  /**
   * Update the system clock once per second and cancel the interval on unmount.
   */
  useEffect(() => {
    const timer = setInterval(
      /**
       * Advance timer's timed update; the surrounding lifecycle clears this interval when no longer needed.
       */
      () => setTime(readClock()),
      1000
    )
    /**
     * Release the listeners, timers, or focus ownership acquired by useClock's effect before it reruns or unmounts.
     */
    return () => clearInterval(timer)
  }, [])
  return time
}
