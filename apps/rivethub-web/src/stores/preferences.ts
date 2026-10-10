/**
 * Settings → General. App-wide preferences that are not tied to one
 * conversation, space or node.
 *
 * `newChat` uses the space-defaults shape: a new conversation outside a
 * space with its own defaults (and with no agent picked in the rail) starts
 * with this agent preset and thinking level.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { HarnessId, ThinkingLevel } from '@rivetos/types'
import type { SpaceDefaults } from './spaces.js'

const KEY = 'rivethub.preferences'

const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh']

export interface Preferences {
  newChat: Pick<SpaceDefaults, 'agentId' | 'harnessId' | 'effort'>
  /** Jump to the newest message when a reply lands or a turn ends. */
  autoScroll: boolean
  /** OS notifications (escalations, gates, finished replies). In-app toasts stay. */
  desktopNotifications: boolean
  /** Notify when an agent finishes a reply you are not looking at. */
  notifyAgentFinished: boolean
  /** A short chime with each OS notification. */
  notificationSound: boolean
}

interface PreferencesState extends Preferences {
  setNewChat: (patch: Partial<Preferences['newChat']>) => void
  set: (patch: Partial<Omit<Preferences, 'newChat'>>) => void
}

export const DEFAULT_PREFERENCES: Preferences = {
  newChat: {},
  autoScroll: true,
  desktopNotifications: true,
  notifyAgentFinished: true,
  notificationSound: false,
}

/** Keep only well-formed fields from persisted data. */
export function normalizePreferences(raw: unknown): Preferences {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const chat =
    r.newChat !== null && typeof r.newChat === 'object'
      ? (r.newChat as Record<string, unknown>)
      : {}
  const newChat: Preferences['newChat'] = {}
  if (typeof chat.agentId === 'string' && chat.agentId) newChat.agentId = chat.agentId
  if (typeof chat.harnessId === 'string' && chat.harnessId) {
    newChat.harnessId = chat.harnessId as HarnessId
  }
  if ((THINKING_LEVELS as readonly unknown[]).includes(chat.effort)) {
    newChat.effort = chat.effort as ThinkingLevel
  }
  const flag = (key: keyof Omit<Preferences, 'newChat'>): boolean =>
    typeof r[key] === 'boolean' ? r[key] : DEFAULT_PREFERENCES[key]
  return {
    newChat,
    autoScroll: flag('autoScroll'),
    desktopNotifications: flag('desktopNotifications'),
    notifyAgentFinished: flag('notifyAgentFinished'),
    notificationSound: flag('notificationSound'),
  }
}

export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      setNewChat: (patch) =>
        // An empty value clears the field, so "None" stores nothing.
        set((s) => ({
          newChat: Object.fromEntries(
            Object.entries({ ...s.newChat, ...patch }).filter(([, value]) => Boolean(value)),
          ),
        })),
      set: (patch) => set(patch),
    }),
    {
      name: KEY,
      // Storage may be missing (tests, private window); defaults still apply.
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          try {
            return globalThis.localStorage.getItem(name)
          } catch {
            return null
          }
        },
        setItem: (name, value) => {
          try {
            globalThis.localStorage.setItem(name, value)
          } catch {
            /* not persisted */
          }
        },
        removeItem: (name) => {
          try {
            globalThis.localStorage.removeItem(name)
          } catch {
            /* not persisted */
          }
        },
      })),
      partialize: (s): Preferences => ({
        newChat: s.newChat,
        autoScroll: s.autoScroll,
        desktopNotifications: s.desktopNotifications,
        notifyAgentFinished: s.notifyAgentFinished,
        notificationSound: s.notificationSound,
      }),
      merge: (persisted, current) => ({ ...current, ...normalizePreferences(persisted) }),
    },
  ),
)

export const PREFERENCES_STORAGE_KEY = KEY
