import { useEffect, useState } from 'react'

const readClock = () =>
  new Date().toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })

export default function useClock() {
  const [time, setTime] = useState(readClock)
  useEffect(() => {
    const timer = setInterval(() => setTime(readClock()), 1000)
    return () => clearInterval(timer)
  }, [])
  return time
}
