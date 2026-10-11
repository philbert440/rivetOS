import { useKeyBindings } from '../stores/key-bindings.js'
import { keyLabel } from './hub-keys.js'

/** `keyLabel`, re-rendering the caller when a shortcut is rebound. */
export function useKeyLabel(): (id: string) => string {
  useKeyBindings((s) => s.overrides)
  return keyLabel
}
