import { describe, it, expect, vi } from 'vitest'
import { applyBootNodeParam, parseBootNodeParam } from './boot-node-param.js'

describe('parseBootNodeParam', () => {
  it('reads ?node= as a gateway origin', () => {
    expect(parseBootNodeParam('?node=http%3A%2F%2F192.168.1.9%3A5174')).toEqual({
      baseUrl: 'http://192.168.1.9:5174',
    })
  })

  it('accepts plain (already-decoded) node values from URLSearchParams', () => {
    expect(parseBootNodeParam('?node=http://192.168.1.9:5174')).toEqual({
      baseUrl: 'http://192.168.1.9:5174',
    })
  })

  it('ignores legacy ?token= (bearer removed)', () => {
    expect(parseBootNodeParam('?node=http://192.168.1.9:5174&token=sekrit')).toEqual({
      baseUrl: 'http://192.168.1.9:5174',
    })
  })

  it('returns null when absent or invalid', () => {
    expect(parseBootNodeParam('')).toBeNull()
    expect(parseBootNodeParam('?foo=1')).toBeNull()
    expect(parseBootNodeParam('?node=javascript:alert(1)')).toBeNull()
    expect(parseBootNodeParam('?node=http://user:pass@192.168.1.5:5174')).toBeNull()
  })
})

describe('applyBootNodeParam', () => {
  it('setConnection + addNode + strips query params', () => {
    const setConnection = vi.fn()
    const addNode = vi.fn()
    const replaceState = vi.fn()
    const ok = applyBootNodeParam(
      { setConnection, addNode },
      {
        search: '?node=http%3A%2F%2F192.168.1.9%3A5174&token=t1&keep=1',
        href: 'http://127.0.0.1:5174/?node=http%3A%2F%2F192.168.1.9%3A5174&token=t1&keep=1',
        replaceState,
      },
    )
    expect(ok).toBe(true)
    expect(setConnection).toHaveBeenCalledWith('http://192.168.1.9:5174')
    expect(addNode).toHaveBeenCalledWith({
      name: '192.168.1.9:5174',
      baseUrl: 'http://192.168.1.9:5174',
    })
    expect(replaceState).toHaveBeenCalledWith('/?keep=1')
  })

  it('no-op when ?node= missing', () => {
    const setConnection = vi.fn()
    const addNode = vi.fn()
    const replaceState = vi.fn()
    expect(
      applyBootNodeParam(
        { setConnection, addNode },
        { search: '', href: 'http://127.0.0.1:5174/', replaceState },
      ),
    ).toBe(false)
    expect(setConnection).not.toHaveBeenCalled()
    expect(addNode).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })
})
