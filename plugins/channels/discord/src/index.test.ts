import { describe, it, expect } from 'vitest'
import { DiscordChannel, manifest } from './index.js'

describe('manifest', () => {
  it('declares a channel plugin named "discord"', () => {
    expect(manifest.type).toBe('channel')
    expect(manifest.name).toBe('discord')
    expect(typeof manifest.register).toBe('function')
  })
})

describe('DiscordChannel', () => {
  it('initializes identity props from config', () => {
    const ch = new DiscordChannel({ botToken: 'test', ownerId: '12345' })
    expect(ch.platform).toBe('discord')
    expect(ch.id).toBe('discord:12345')
    expect(ch.maxMessageLength).toBe(2000)
  })
})
