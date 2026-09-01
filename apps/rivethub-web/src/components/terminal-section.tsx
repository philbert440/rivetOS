/**
 * Settings → Terminal — font, cursor, scrollback, renderer, bell, clipboard
 * gestures, and palette source for the embedded xterm
 * (stores/terminal-settings.ts). Every change re-options any live terminal
 * in place; the static preview below shows font + palette without opening
 * one.
 */

import { useEffect, useState, type JSX } from 'react'
import { Select } from './select.js'
import { useResolvedTheme } from '../stores/theme.js'
import {
  resolveXtermTheme,
  TERMINAL_LIMITS,
  useTerminalSettings,
  type TerminalSettings,
} from '../stores/terminal-settings.js'
import { TERMINAL_SCHEMES, XTERM_DEFAULT_ANSI, type XtermTheme } from '../lib/terminal-schemes.js'

function Row(props: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <span className="text-xs text-ink-dim">{props.label}</span>
      {props.children}
    </div>
  )
}

/** Boolean switch as an aria-pressed pill — the same visual language as the
 *  Appearance theme buttons (no native controls: WebKitGTK paints them as OS
 *  chrome). */
function Toggle(props: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.value}
      aria-label={props.label}
      onClick={() => props.onChange(!props.value)}
      className={
        props.value
          ? 'rounded bg-em-dim px-3 py-1 text-xs font-medium text-bg'
          : 'rounded border border-line bg-panel-2 px-3 py-1 text-xs hover:border-em'
      }
    >
      {props.value ? 'On' : 'Off'}
    </button>
  )
}

/** Draft-commit number input: the store clamps on commit, but typing an
 *  intermediate value ("1." of "1.2") must not get normalized mid-keystroke. */
function NumberField(props: {
  ariaLabel: string
  value: number
  onCommit: (v: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(props.value))
  useEffect(() => setDraft(String(props.value)), [props.value])
  const commit = (): void => {
    const n = Number(draft)
    if (Number.isFinite(n)) props.onCommit(n)
    else setDraft(String(props.value))
  }
  return (
    <input
      value={draft}
      inputMode="decimal"
      aria-label={props.ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          e.currentTarget.blur()
        }
      }}
      className="w-20 rounded border border-line bg-panel-2 px-2 py-1 text-right font-mono text-xs outline-none focus:border-em"
    />
  )
}

const ANSI_SWATCH_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

/** Static font/palette sample — no xterm instance needed. The `app` source
 *  leaves the ANSI ramp at the emulator defaults, so swatches fall back to
 *  those when the resolved theme doesn't name a color. */
function TerminalPreview(props: { settings: TerminalSettings; theme: XtermTheme }): JSX.Element {
  const { settings, theme } = props
  return (
    <pre
      className="mt-2 overflow-x-auto rounded border border-line p-3"
      style={{
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        letterSpacing: settings.letterSpacing,
        fontFeatureSettings: settings.ligatures ? '"liga" 1, "calt" 1' : undefined,
        backgroundColor: theme.background,
        color: theme.foreground,
      }}
    >
      <div>The quick brown fox jumps over the lazy dog 0123456789</div>
      <div>{'-> => != <= |> == [] {} ()'}</div>
      <div className="mt-2 flex">
        {ANSI_SWATCH_KEYS.slice(0, 8).map((key, i) => (
          <span
            key={key}
            title={key}
            className="inline-block h-4 flex-1"
            style={{ backgroundColor: theme[key] ?? XTERM_DEFAULT_ANSI[i] }}
          />
        ))}
      </div>
      <div className="flex">
        {ANSI_SWATCH_KEYS.slice(8).map((key, i) => (
          <span
            key={key}
            title={key}
            className="inline-block h-4 flex-1"
            style={{ backgroundColor: theme[key] ?? XTERM_DEFAULT_ANSI[i + 8] }}
          />
        ))}
      </div>
    </pre>
  )
}

export function TerminalSection(): JSX.Element {
  const settings = useTerminalSettings()
  const resolvedTheme = useResolvedTheme()
  const update = settings.update
  const theme = resolveXtermTheme(settings, resolvedTheme)
  const webglUnavailable = settings.renderer === 'webgl' && settings.rendererActual === 'canvas'

  return (
    <>
      <h2 className="mt-10 mb-3 border-t border-line pt-6 font-mono text-sm font-semibold text-em">
        Terminal
      </h2>

      <span className="mb-1 block text-xs text-ink-dim">Color palette</span>
      <div className="flex gap-2" role="group" aria-label="Terminal palette source">
        {(
          [
            ['app', 'App theme'],
            ['scheme', 'Color scheme'],
            ['imported', 'Imported'],
          ] as [TerminalSettings['themeSource'], string][]
        ).map(([value, label]) => {
          const disabled = value === 'imported' && !settings.imported
          return (
            <button
              key={value}
              type="button"
              aria-pressed={settings.themeSource === value}
              disabled={disabled}
              title={disabled ? 'Import a config in the desktop app' : undefined}
              onClick={() => update({ themeSource: value })}
              className={
                settings.themeSource === value
                  ? 'rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg'
                  : 'rounded border border-line bg-panel-2 px-4 py-2 text-sm hover:border-em disabled:cursor-not-allowed disabled:opacity-40'
              }
            >
              {label}
            </button>
          )
        })}
      </div>
      {settings.themeSource === 'scheme' && (
        <div className="mt-2">
          <Select
            value={settings.scheme}
            options={TERMINAL_SCHEMES.map((s) => ({
              value: s.id,
              label: s.label,
              group: s.dark ? 'Dark' : 'Light',
            }))}
            onChange={(id) => update({ scheme: id })}
            title="Terminal color scheme"
          />
        </div>
      )}
      {settings.themeSource === 'imported' && settings.imported && (
        <p className="mt-2 text-xs text-ink-dim">Palette imported from your emulator config.</p>
      )}
      {settings.themeSource === 'app' && (
        <p className="mt-2 text-xs text-ink-dim">
          Follows the app theme (ANSI colors stay at the emulator defaults).
        </p>
      )}

      <div className="mt-4">
        <label className="mb-1 block text-xs text-ink-dim">Font family</label>
        <input
          value={settings.fontFamily}
          onChange={(e) => update({ fontFamily: e.target.value })}
          placeholder="'JetBrains Mono', monospace"
          className="mb-2 w-full rounded border border-line bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-em"
        />
      </div>

      <Row label={`Font size (${TERMINAL_LIMITS.fontSize.min}–${TERMINAL_LIMITS.fontSize.max})`}>
        <NumberField
          ariaLabel="Terminal font size"
          value={settings.fontSize}
          onCommit={(v) => update({ fontSize: v })}
        />
      </Row>
      <Row
        label={`Line height (${TERMINAL_LIMITS.lineHeight.min}–${TERMINAL_LIMITS.lineHeight.max})`}
      >
        <NumberField
          ariaLabel="Terminal line height"
          value={settings.lineHeight}
          onCommit={(v) => update({ lineHeight: v })}
        />
      </Row>
      <Row label="Letter spacing (px)">
        <NumberField
          ariaLabel="Terminal letter spacing"
          value={settings.letterSpacing}
          onCommit={(v) => update({ letterSpacing: v })}
        />
      </Row>
      <Row label="Ligatures">
        <Toggle
          label="Terminal ligatures"
          value={settings.ligatures}
          onChange={(v) => update({ ligatures: v })}
        />
      </Row>
      <p className="mb-2 text-xs text-ink-dim">
        Best-effort: xterm renders glyphs itself, so CSS ligatures only apply with the DOM renderer
        (not WebGL) and only for fonts that ship liga/calt tables.
      </p>

      <Row label="Cursor style">
        <Select
          value={settings.cursorStyle}
          options={[
            { value: 'block', label: 'Block' },
            { value: 'underline', label: 'Underline' },
            { value: 'bar', label: 'Bar' },
          ]}
          onChange={(v) => update({ cursorStyle: v as TerminalSettings['cursorStyle'] })}
          title="Cursor style"
        />
      </Row>
      <Row label="Cursor blink">
        <Toggle
          label="Terminal cursor blink"
          value={settings.cursorBlink}
          onChange={(v) => update({ cursorBlink: v })}
        />
      </Row>
      <Row
        label={`Scrollback lines (${TERMINAL_LIMITS.scrollback.min}–${TERMINAL_LIMITS.scrollback.max})`}
      >
        <NumberField
          ariaLabel="Terminal scrollback"
          value={settings.scrollback}
          onCommit={(v) => update({ scrollback: v })}
        />
      </Row>

      <Row label="Renderer">
        <Select
          value={settings.renderer}
          options={[
            { value: 'webgl', label: 'WebGL' },
            { value: 'canvas', label: 'Canvas (fallback)' },
          ]}
          onChange={(v) => update({ renderer: v as TerminalSettings['renderer'] })}
          title="Terminal renderer"
        />
      </Row>
      {webglUnavailable && (
        <p className="mb-2 text-xs text-ink-dim">WebGL unavailable, using canvas.</p>
      )}

      <Row label="Bell">
        <Select
          value={settings.bell}
          options={[
            { value: 'none', label: 'None' },
            { value: 'visual', label: 'Visual flash' },
          ]}
          onChange={(v) => update({ bell: v as TerminalSettings['bell'] })}
          title="Terminal bell"
        />
      </Row>
      <Row label="Copy on select">
        <Toggle
          label="Terminal copy on select"
          value={settings.copyOnSelect}
          onChange={(v) => update({ copyOnSelect: v })}
        />
      </Row>
      <Row label="Right-click paste">
        <Toggle
          label="Terminal right-click paste"
          value={settings.rightClickPaste}
          onChange={(v) => update({ rightClickPaste: v })}
        />
      </Row>

      <TerminalPreview settings={settings} theme={theme} />

      <div className="mt-3">
        <button
          type="button"
          onClick={() => settings.resetToDefaults()}
          className="rounded border border-line px-3 py-1 text-xs hover:border-em"
        >
          Reset to defaults
        </button>
      </div>
    </>
  )
}
