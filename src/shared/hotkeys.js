export const DEFAULT_HOTKEYS = { gamepad: [8, 9], keyboard: [] }
export const PAD_LABELS = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'View',
  'Menu',
  'L3',
  'R3',
  '↑',
  '↓',
  '←',
  '→',
  'Guide'
]
export const keyboardCode = (event) =>
  event.code ||
  (event.key?.length === 1
    ? (/^[0-9]$/.test(event.key) ? 'Digit' : 'Key') + event.key.toUpperCase()
    : event.key)
export const validKey = (code) =>
  typeof code === 'string' &&
  /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Arrow(Up|Down|Left|Right)|Space|Tab|Enter|Backspace|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right))$/.test(
    code
  )
export function normalizeHotkeys(value) {
  const pair = (items, valid) =>
    Array.isArray(items) && items.length === 2 && items[0] !== items[1] && items.every(valid)
  return {
    gamepad: pair(value?.gamepad, (n) => Number.isInteger(n) && n >= 0 && n <= 16 && n !== 1)
      ? [...value.gamepad]
      : [...DEFAULT_HOTKEYS.gamepad],
    keyboard: pair(value?.keyboard, validKey) ? [...value.keyboard] : []
  }
}
export const keyLabel = (code) =>
  ({ ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' })[code] ||
  code.replace(/^(Key|Digit)/, '').replace(/(Left|Right)$/, '')
export function windowsKeyCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3)
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5)
  if (/^F\d+$/.test(code)) return 111 + Number(code.slice(1))
  return (
    {
      Escape: 27,
      Space: 32,
      Tab: 9,
      Enter: 13,
      Backspace: 8,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      ShiftLeft: 160,
      ShiftRight: 161,
      ControlLeft: 162,
      ControlRight: 163,
      AltLeft: 164,
      AltRight: 165
    }[code] || 0
  )
}

// Defer a remapped button's standalone action until release, so a chord never
// launches a game or opens search/filter/settings on its first constituent.
export function createGamepadHotkey() {
  let held = false,
    consumed = false
  return (frame, pair, surfaceOpen = false) => {
    const down = pair.every((index) => frame.buttons?.[index])
    const triggered = down && !held
    if (triggered || (surfaceOpen && pair.some((index) => frame.buttons?.[index]))) consumed = true
    const blocked = consumed
    const hit = (index) =>
      pair.includes(index) ? !blocked && !!frame.released?.(index) : frame.hit(index)
    held = down
    if (pair.every((index) => !frame.buttons?.[index])) consumed = false
    return { triggered, hit }
  }
}
