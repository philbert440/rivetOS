import { describe, it, expect } from 'vitest'
import { TelegramChannel, manifest } from './index.js'

describe('manifest', () => {
  it('declares a channel plugin named "telegram"', () => {
    expect(manifest.type).toBe('channel')
    expect(manifest.name).toBe('telegram')
    expect(typeof manifest.register).toBe('function')
  })
})

describe('TelegramChannel', () => {
  it('initializes identity props from config', () => {
    const ch = new TelegramChannel({ botToken: 'test', ownerId: '12345' })
    expect(ch.platform).toBe('telegram')
    expect(ch.id).toBe('telegram:12345')
    expect(ch.maxMessageLength).toBe(4096)
  })
})
