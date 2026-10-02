import { createContext } from 'react'

/** Last active input device shared by badges and gamepad-only OSK triggers; keyboard is the initial mode. */
export const InputContext = createContext('keyboard')
