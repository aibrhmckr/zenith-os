import { useEffect, useRef, useState } from 'react'

function batteryPercent(pad) {
  const battery = pad?.battery
  const percentage = battery?.percentage
  if (Number.isFinite(percentage)) return Math.round(Math.max(0, Math.min(100, percentage)))
  const level = typeof battery === 'number' ? battery : battery?.level
  if (!Number.isFinite(level)) return null
  return Math.round(Math.max(0, Math.min(100, level <= 1 ? level * 100 : level)))
}

// One poller owns edges and repeat timing across all input surfaces.
export default function useController(onFrame) {
  const callbackRef = useRef(onFrame)
  const modeRef = useRef('keyboard')
  const [mode, setMode] = useState('keyboard')
  const [controller, setController] = useState(null)
  useEffect(() => {
    callbackRef.current = onFrame
  }, [onFrame])
  useEffect(() => {
    let frameId
    let previous = []
    let previousAxes = []
    let identity = null
    let lastDirection = null
    let repeatAt = 0
    let statusKey = ''
    const changeMode = (value) => {
      document.documentElement.dataset.inputMode = value
      if (modeRef.current === value) return
      modeRef.current = value
      setMode(value)
    }
    const keyboard = () => changeMode('keyboard')
    window.addEventListener('keydown', keyboard, true)
    window.addEventListener('pointerdown', keyboard, true)
    const poll = (now) => {
      let pad
      try {
        pad = Array.from(navigator.getGamepads?.() || []).find((value) => value?.connected)
      } catch {
        /* Some environments do not expose the Gamepad API. */
      }
      const key = pad ? `${pad.index}:${pad.id}` : null
      if (identity !== key) {
        identity = key
        previous = []
        previousAxes = []
        lastDirection = null
      }
      const battery = batteryPercent(pad)
      const nextStatus = JSON.stringify([key, battery])
      if (statusKey !== nextStatus) {
        statusKey = nextStatus
        setController(pad ? { id: pad.id, battery } : null)
        if (!pad) changeMode('keyboard')
      }
      if (pad) {
        const buttons = Array.from(pad.buttons, (button) => Boolean(button?.pressed))
        const hit = (index) => buttons[index] && !previous[index]
        const axes = Array.from(pad.axes || [], (axis) => (Math.abs(axis) > 0.25 ? axis : 0))
        if (
          buttons.some((value, i) => value && !previous[i]) ||
          axes.some((value, i) => value && Math.abs(value - (previousAxes[i] || 0)) > 0.1)
        ) {
          changeMode('gamepad')
        }
        const direction =
          buttons[15] || axes[0] > 0.5
            ? 'right'
            : buttons[14] || axes[0] < -0.5
              ? 'left'
              : buttons[13] || axes[1] > 0.5
                ? 'down'
                : buttons[12] || axes[1] < -0.5
                  ? 'up'
                  : null
        const move =
          direction && (direction !== lastDirection || now >= repeatAt) ? direction : null
        if (move) repeatAt = now + (direction !== lastDirection ? 350 : 150)
        const released = (index) => !buttons[index] && !!previous[index]
        try {
          callbackRef.current({
            hit,
            released,
            buttons,
            axes,
            move,
            now,
            inputMode: modeRef.current
          })
        } catch (error) {
          console.error('Controller frame failed:', error)
        }
        previous = buttons
        previousAxes = axes
        lastDirection = direction
      }
      frameId = requestAnimationFrame(poll)
    }
    frameId = requestAnimationFrame(poll)
    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener('keydown', keyboard, true)
      window.removeEventListener('pointerdown', keyboard, true)
    }
  }, [])
  return { mode, modeRef, controller }
}
