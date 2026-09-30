import { describe, it, expect } from 'vitest'
import {
  approvalActionText,
  humanToolTitle,
  pendingToolTitle,
  normalizeToolName,
} from './tool-titles.js'

describe('normalizeToolName', () => {
  it('strips emoji prefixes from stream content', () => {
    expect(normalizeToolName('🔧 shell')).toBe('shell')
    expect(normalizeToolName('✅ Bash')).toBe('Bash')
  })
})

describe('humanToolTitle', () => {
  it('titles Claude Bash with description or command', () => {
    expect(humanToolTitle('Bash', { description: 'list files' })).toBe('Ran: list files')
    expect(humanToolTitle('Bash', { command: 'ls -la' })).toBe('Ran: ls -la')
    expect(humanToolTitle('Bash')).toBe('Ran a command')
  })

  it('titles Claude file tools with basename', () => {
    expect(humanToolTitle('Read', { file_path: '/a/b/foo.ts' })).toBe('Read foo.ts')
    expect(humanToolTitle('Edit', { file_path: '/x/y/bar.tsx' })).toBe('Edited bar.tsx')
    expect(humanToolTitle('Write', { file_path: 'z.md' })).toBe('Wrote z.md')
  })

  it('titles Grok tools', () => {
    expect(humanToolTitle('run_terminal_command', { command: 'pwd' })).toBe('Ran: pwd')
    expect(humanToolTitle('read_file', { path: '/tmp/a.txt' })).toBe('Read a.txt')
    expect(humanToolTitle('search_replace', { path: 'src/x.ts' })).toBe('Edited x.ts')
    expect(humanToolTitle('web_search', { query: 'rivetos' })).toBe('Searched web: rivetos')
    expect(humanToolTitle('ask_user_question')).toBe('Asked a question')
  })

  it('labels a pending shell as Run and shows the full command, not the description', () => {
    const command = 'ls -la /tmp && echo done with a command longer than forty eight characters'
    const input = { description: 'list files', command }
    expect(pendingToolTitle('Bash', input)).toBe('Run: list files')
    expect(pendingToolTitle('Bash')).toBe('Run a command')
    expect(humanToolTitle('Bash', input)).toBe('Ran: list files')
    expect(approvalActionText('Bash', input)).toBe(command)
    expect(approvalActionText('Bash', { description: 'list files' })).toBeUndefined()
  })

  it('shows a write or edit path plus the payload', () => {
    expect(
      approvalActionText('Edit', {
        file_path: '/x/y/bar.tsx',
        old_string: 'a',
        new_string: 'b',
        description: 'rename',
      }),
    ).toBe('/x/y/bar.tsx\nold_string:\na\n\nnew_string:\nb')
    expect(approvalActionText('Write', { file_path: 'z.md', content: '# hi' })).toBe(
      'z.md\ncontent:\n# hi',
    )
  })

  it('falls back sanely for unknown tools', () => {
    expect(humanToolTitle('my_custom_tool')).toBe('my custom tool')
    expect(humanToolTitle('mcp:rivetos:memory_search')).toBe('memory search')
  })
})
