/* eslint-disable react/prop-types -- Shared internal input hint components. */
import { useContext } from 'react'
import { InputContext } from '../hooks/inputContext'
import GamepadBadge from './GamepadBadge'

/**
 * Render a keyboard label or Xbox-style colored badge according to InputContext, keeping help
 * aligned with the last active device.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.keyboard - Physical keyboard shortcut label.
 * @param {string} options.gamepad - Gamepad badge label.
 */
export function KeyBadge({ keyboard, gamepad }) {
  const mode = useContext(InputContext)
  if (mode === 'gamepad') return <GamepadBadge button={gamepad} />
  return (
    <kbd data-input-mode={mode} className="input-badge keyboard-badge">
      {keyboard}
    </kbd>
  )
}

/**
 * Combine the active-device badge with an action description supplied as children.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {string} options.keyboard - Physical keyboard shortcut label.
 * @param {string} options.gamepad - Gamepad badge label.
 * @param {import("react").ReactNode} options.children - Nested content rendered within the provider, dialog, or hint.
 */
export default function InputHint({ keyboard, gamepad, children }) {
  return (
    <span className="input-hint">
      <KeyBadge keyboard={keyboard} gamepad={gamepad} />
      {children}
    </span>
  )
}
