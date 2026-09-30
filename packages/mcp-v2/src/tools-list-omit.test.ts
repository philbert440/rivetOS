import { describe, expect, it } from 'vitest'
import { omitToolsFromList } from './server.js'

describe('omitToolsFromList', () => {
  const omit = new Set(['request_permission'])

  it('drops the named tool and keeps every other field', () => {
    const result = omitToolsFromList(
      {
        tools: [
          { name: 'echo_test', description: 'echo' },
          { name: 'request_permission', description: 'park' },
          { name: 'add_test' },
        ],
        nextCursor: 'page-2',
      },
      omit,
    )
    expect(result).toEqual({
      tools: [
        { name: 'echo_test', description: 'echo' },
        { name: 'add_test' },
      ],
      nextCursor: 'page-2',
    })
  })

  it('leaves a non-list payload, and tools with no name, unchanged', () => {
    expect(omitToolsFromList(undefined, omit)).toBeUndefined()
    expect(omitToolsFromList('tools/list', omit)).toBe('tools/list')
    expect(omitToolsFromList({ tools: 'nope' }, omit)).toEqual({ tools: 'nope' })
    const nameless = { tools: [{ description: 'unnamed' }, null, { name: 1 }] }
    expect(omitToolsFromList(nameless, omit)).toEqual(nameless)
  })

  it('an empty omit set removes nothing', () => {
    const listed = { tools: [{ name: 'request_permission' }] }
    expect(omitToolsFromList(listed, new Set())).toEqual(listed)
  })
})
