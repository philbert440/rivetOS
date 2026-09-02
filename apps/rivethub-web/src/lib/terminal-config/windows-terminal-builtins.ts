/**
 * Built-in Windows Terminal color schemes from `defaults.json`.
 *
 * Current WT versions do not copy these into the user's `schemes` array, so
 * a stock install's `colorScheme: "Campbell"` would otherwise fail to
 * resolve. Values are the official 16 ANSI + named colors, already
 * normalised to lower-case `#rrggbb`.
 */

export interface WindowsTerminalBuiltinScheme {
  name: string
  foreground: string
  background: string
  cursorColor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  purple: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightPurple: string
  brightCyan: string
  brightWhite: string
}

const campbellAnsi = {
  black: '#0c0c0c',
  red: '#c50f1f',
  green: '#13a10e',
  yellow: '#c19c00',
  blue: '#0037da',
  purple: '#881798',
  cyan: '#3a96dd',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#e74856',
  brightGreen: '#16c60c',
  brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff',
  brightPurple: '#b4009e',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2',
} as const

const solarizedAnsi = {
  black: '#002b36',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  purple: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#073642',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightPurple: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
} as const

const tangoAnsi = {
  black: '#000000',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#c4a000',
  blue: '#3465a4',
  purple: '#75507b',
  cyan: '#06989a',
  white: '#d3d7cf',
  brightBlack: '#555753',
  brightRed: '#ef2929',
  brightGreen: '#8ae234',
  brightYellow: '#fce94f',
  brightBlue: '#729fcf',
  brightPurple: '#ad7fa8',
  brightCyan: '#34e2e2',
  brightWhite: '#eeeeec',
} as const

/** Nine schemes shipped in Windows Terminal's `defaults.json`. */
export const WINDOWS_TERMINAL_BUILTINS: Readonly<Record<string, WindowsTerminalBuiltinScheme>> = {
  Campbell: {
    name: 'Campbell',
    foreground: '#cccccc',
    background: '#0c0c0c',
    cursorColor: '#ffffff',
    selectionBackground: '#ffffff',
    ...campbellAnsi,
  },
  'Campbell Powershell': {
    name: 'Campbell Powershell',
    foreground: '#cccccc',
    background: '#012456',
    cursorColor: '#ffffff',
    selectionBackground: '#ffffff',
    ...campbellAnsi,
  },
  Vintage: {
    name: 'Vintage',
    foreground: '#c0c0c0',
    background: '#000000',
    cursorColor: '#ffffff',
    selectionBackground: '#ffffff',
    black: '#000000',
    red: '#800000',
    green: '#008000',
    yellow: '#808000',
    blue: '#000080',
    purple: '#800080',
    cyan: '#008080',
    white: '#c0c0c0',
    brightBlack: '#808080',
    brightRed: '#ff0000',
    brightGreen: '#00ff00',
    brightYellow: '#ffff00',
    brightBlue: '#0000ff',
    brightPurple: '#ff00ff',
    brightCyan: '#00ffff',
    brightWhite: '#ffffff',
  },
  'One Half Dark': {
    name: 'One Half Dark',
    foreground: '#dcdfe4',
    background: '#282c34',
    cursorColor: '#ffffff',
    selectionBackground: '#ffffff',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    purple: '#c678dd',
    cyan: '#56b6c2',
    white: '#dcdfe4',
    brightBlack: '#5a6374',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightPurple: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#dcdfe4',
  },
  'One Half Light': {
    name: 'One Half Light',
    foreground: '#383a42',
    background: '#fafafa',
    cursorColor: '#4f525e',
    selectionBackground: '#ffffff',
    black: '#383a42',
    red: '#e45649',
    green: '#50a14f',
    yellow: '#c18401',
    blue: '#0184bc',
    purple: '#a626a4',
    cyan: '#0997b3',
    white: '#fafafa',
    brightBlack: '#4f525e',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e4c07a',
    brightBlue: '#61afef',
    brightPurple: '#c577dd',
    brightCyan: '#56b5c1',
    brightWhite: '#ffffff',
  },
  'Solarized Dark': {
    name: 'Solarized Dark',
    foreground: '#839496',
    background: '#002b36',
    cursorColor: '#ffffff',
    selectionBackground: '#ffffff',
    ...solarizedAnsi,
  },
  'Solarized Light': {
    name: 'Solarized Light',
    foreground: '#657b83',
    background: '#fdf6e3',
    cursorColor: '#002b36',
    selectionBackground: '#ffffff',
    ...solarizedAnsi,
  },
  'Tango Dark': {
    name: 'Tango Dark',
    foreground: '#d3d7cf',
    background: '#000000',
    cursorColor: '#ffffff',
    selectionBackground: '#ffffff',
    ...tangoAnsi,
  },
  'Tango Light': {
    name: 'Tango Light',
    foreground: '#555753',
    background: '#ffffff',
    cursorColor: '#000000',
    selectionBackground: '#ffffff',
    ...tangoAnsi,
  },
}

export const WINDOWS_TERMINAL_DEFAULT_SCHEME = 'Campbell'
