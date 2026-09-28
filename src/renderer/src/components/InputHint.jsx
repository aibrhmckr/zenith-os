/* eslint-disable react/prop-types -- Shared internal input hint components. */
import { useContext } from 'react'
import { InputContext } from '../hooks/inputContext'

export function KeyBadge({ keyboard, gamepad }) {
  const mode = useContext(InputContext)
  const label = mode === 'gamepad' ? gamepad : keyboard
  return (
    <kbd
      data-input-mode={mode}
      className={`input-badge ${mode === 'gamepad' ? `pad-badge pad-${gamepad}` : 'keyboard-badge'}`}
    >
      {label}
    </kbd>
  )
}

export default function InputHint({ keyboard, gamepad, children }) {
  return (
    <span className="input-hint">
      <KeyBadge keyboard={keyboard} gamepad={gamepad} />
      {children}
    </span>
  )
}
