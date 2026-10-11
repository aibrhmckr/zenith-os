/** One idle timer for the entire document, including native dialog top layers. */
export function createCursorVisibility({
  setHidden,
  schedule = setTimeout,
  cancel = clearTimeout
}) {
  let timer
  const hide = () => {
    cancel(timer)
    setHidden(true)
  }
  const move = () => {
    cancel(timer)
    setHidden(false)
    timer = schedule(hide, 2000)
  }
  move()
  return {
    move,
    gamepad: hide,
    dispose: () => {
      cancel(timer)
      setHidden(false)
    }
  }
}
