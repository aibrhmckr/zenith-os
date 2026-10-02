import { useEffect, useRef, useState } from 'react'

/**
 * Normalize optional vendor battery data into 0–100 percent; return null when the standard
 * Gamepad object provides no battery data.
 *
 * @param {Object} pad - Connected Gamepad, including optional nonstandard battery metadata.
 */
function batteryPercent(pad) {
  const battery = pad?.battery
  const percentage = battery?.percentage
  if (Number.isFinite(percentage)) return Math.round(Math.max(0, Math.min(100, percentage)))
  const level = typeof battery === 'number' ? battery : battery?.level
  if (!Number.isFinite(level)) return null
  return Math.round(Math.max(0, Math.min(100, level <= 1 ? level * 100 : level)))
}

// One poller owns edges and repeat timing across all input surfaces.
/**
 * Poll the first connected gamepad once per animation frame and share edge/repeat semantics
 * across all surfaces. Ignore small stick drift and track the most recent input device.
 *
 * @param {Function} onFrame - Receives hit/released, buttons, axes, move, timestamp, and current input mode per animation frame.
 */
export default function useController(onFrame) {
  /**
   * Latest routing callback without restarting the animation-frame poller on every App render.
   */
  const callbackRef = useRef(onFrame)
  /**
   * Synchronous last-input mode is visible to the same controller frame that changes it.
   */
  const modeRef = useRef('keyboard')
  /**
   * React-visible input mode for badges and conditional OSK behavior.
   */
  const [mode, setMode] = useState('keyboard')
  /**
   * First connected device identity and optional battery percentage; null hides P1 status.
   */
  const [controller, setController] = useState(null)
  /**
   * Refresh the frame callback without restarting polling or losing button-edge history.
   */
  useEffect(() => {
    callbackRef.current = onFrame
  }, [onFrame])
  /**
   * Own one requestAnimationFrame chain plus physical-input listeners; cancel everything when
   * unmounted.
   */
  useEffect(() => {
    let frameId
    /**
     * Previous button states used to derive press and release edges.
     */
    let previous = []
    /**
     * Previous filtered axes used to detect meaningful device input rather than persistent drift.
     */
    let previousAxes = []
    /**
     * Device index/ID pair; changing controllers clears edge history.
     */
    let identity = null
    /**
     * Previous directional intent distinguishes an initial press from a held repeat.
     */
    let lastDirection = null
    /**
     * Next navigation repeat deadline: 350 ms initially, then 150 ms.
     */
    let repeatAt = 0
    /**
     * Deduplicated device/battery snapshot avoids React updates on unchanged polling frames.
     */
    let statusKey = ''
    /**
     * Update both synchronous routing state and React badges only when the active device changes.
     *
     * @param {*} value - Input value being normalized, displayed, or committed by this helper.
     */
    const changeMode = (value) => {
      document.documentElement.dataset.inputMode = value
      if (modeRef.current === value) return
      modeRef.current = value
      setMode(value)
    }
    /**
     * Treat physical keyboard/pointer input as keyboard mode, preventing accidental gamepad OSK
     * activation.
     */
    const keyboard = () => changeMode('keyboard')
    window.addEventListener('keydown', keyboard, true)
    window.addEventListener('pointerdown', keyboard, true)
    /**
     * Read button edges and axes for the current device; apply 0.25 drift deadzone, 0.5 directional
     * threshold, and 350/150-ms navigation repeat timing before calling onFrame.
     *
     * @param {number} now - Animation-frame timestamp in milliseconds.
     */
    const poll = (now) => {
      let pad
      try {
        pad = Array.from(navigator.getGamepads?.() || []).find(
          /**
           * Select the first matching Array.from(navigator.getGamepads?.() || []) entry for poll; absence is handled by the caller's fallback.
           *
           * @param {*} value - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */
          (value) => value?.connected
        )
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
        const buttons = Array.from(
          pad.buttons /**
           * Create an independent buttons entry for each requested slot rather than reusing mutable objects.
           *
           * @param {*} button - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */,
          (button) => Boolean(button?.pressed)
        )
        /**
         * Report a button press edge relative to the prior frame; held buttons do not repeatedly
         * activate actions.
         *
         * @param {number} index - Zero-based selection, button, or page index.
         */
        const hit = (index) => buttons[index] && !previous[index]
        const axes = Array.from(
          pad.axes || [] /**
           * Create an independent axes entry for each requested slot rather than reusing mutable objects.
           *
           * @param {*} axis - Value supplied by the enclosing operation; interpreted in this callback's local scope.
           */,
          (axis) => (Math.abs(axis) > 0.25 ? axis : 0)
        )
        if (
          buttons.some(
            /**
             * Short-circuit when any buttons entry meets poll's condition.
             *
             * @param {*} value - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             * @param {*} i - Zero-based collection index.
             */
            (value, i) => value && !previous[i]
          ) ||
          axes.some(
            /**
             * Short-circuit when any axes entry meets poll's condition.
             *
             * @param {*} value - Value supplied by the enclosing operation; interpreted in this callback's local scope.
             * @param {*} i - Zero-based collection index.
             */
            (value, i) => value && Math.abs(value - (previousAxes[i] || 0)) > 0.1
          )
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
        /**
         * Report a button release edge so chord-assigned actions can be deferred until release.
         *
         * @param {number} index - Zero-based selection, button, or page index.
         */
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
    /**
     * Release the listeners, timers, or focus ownership acquired by useController's effect before it reruns or unmounts.
     */
    return () => {
      cancelAnimationFrame(frameId)
      window.removeEventListener('keydown', keyboard, true)
      window.removeEventListener('pointerdown', keyboard, true)
    }
  }, [])
  return { mode, modeRef, controller }
}
