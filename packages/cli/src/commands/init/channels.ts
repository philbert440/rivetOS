/**
 * Phase 4: Channel configuration — Discord, Telegram, terminal-only.
 */

import * as p from '@clack/prompts'
import type { WizardChannel } from './types.js'

function bail<T>(v: T | symbol): asserts v is T {
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.')
    process.exit(0)
  }
}

export async function configureChannels(): Promise<WizardChannel[]> {
  const channels: WizardChannel[] = []

  const selectedResult = await p.multiselect({
    message: 'Which communication channels do you want to use?',
    options: [
      { value: 'discord' as const, label: 'Discord', hint: 'most popular' },
      { value: 'telegram' as const, label: 'Telegram' },
      { value: 'terminal' as const, label: 'Terminal only', hint: 'no external services needed' },
    ],
    required: true,
  })
  bail(selectedResult)
  const selected: string[] = selectedResult

  // Terminal-only means no channel config needed
  if (selected.length === 1 && selected[0] === 'terminal') {
    p.log.info('Terminal-only mode — no channel tokens needed.')
    return []
  }

  // Filter out 'terminal' if selected alongside other channels
  const channelTypes = selected.filter((s): s is 'discord' | 'telegram' => s !== 'terminal')

  for (const type of channelTypes) {
    if (type === 'discord') {
      const channel = await configureDiscord()
      if (channel) channels.push(channel)
    } else {
      const channel = await configureTelegram()
      if (channel) channels.push(channel)
    }
  }

  return channels
}

async function configureDiscord(): Promise<WizardChannel | null> {
  p.log.step('Discord Setup')

  const hasTokenResult = await p.select({
    message: 'Do you have a Discord bot token?',
    options: [
      { value: 'yes' as const, label: 'Yes, I have a token' },
      { value: 'no' as const, label: 'No, help me create one' },
      { value: 'skip' as const, label: 'Skip Discord for now' },
    ],
  })
  bail(hasTokenResult)
  const hasToken: string = hasTokenResult

  if (hasToken === 'skip') return null

  if (hasToken === 'no') {
    p.note(
      [
        '1. Open https://discord.com/developers/applications',
        '2. Click "New Application" → name it anything',
        '3. Go to Bot → click "Reset Token" → copy it',
        '4. Under "Privileged Gateway Intents" enable:',
        '   • Message Content Intent',
        '   • Server Members Intent',
        '5. Go to OAuth2 → URL Generator',
        '   • Scopes: bot',
        '   • Permissions: Send Messages, Read Messages/View Channels,',
        '     Add Reactions, Use Slash Commands',
        '6. Copy the generated URL and open it to invite the bot',
      ].join('\n'),
      'Create a Discord Bot',
    )
  }

  // Check environment first
  const existingToken = process.env.DISCORD_BOT_TOKEN
  if (existingToken) {
    const useExistingResult = await p.confirm({
      message: 'Found DISCORD_BOT_TOKEN in environment. Use it?',
      initialValue: true,
    })
    bail(useExistingResult)
    if (useExistingResult) {
      const ownerIdResult = await p.text({
        message: 'Your Discord user ID (right-click your name → Copy User ID)',
        placeholder: '123456789012345678',
        validate: (val) =>
          val && /^\d{17,20}$/.test(val.trim())
            ? undefined
            : 'Must be a numeric Discord user ID (17-20 digits)',
      })
      bail(ownerIdResult)
      return { type: 'discord', botToken: existingToken, ownerId: ownerIdResult }
    }
  }

  const tokenResult = await p.password({
    message: 'Discord bot token',
    validate: (val) =>
      val && val.trim().length > 20 ? undefined : "That doesn't look like a valid bot token",
  })
  bail(tokenResult)

  const ownerIdResult = await p.text({
    message: 'Your Discord user ID (right-click your name → Copy User ID)',
    placeholder: '123456789012345678',
    validate: (val) =>
      val && /^\d{17,20}$/.test(val.trim())
        ? undefined
        : 'Must be a numeric Discord user ID (17-20 digits)',
  })
  bail(ownerIdResult)

  p.log.success('Discord configured.')
  return { type: 'discord', botToken: tokenResult, ownerId: ownerIdResult }
}

async function configureTelegram(): Promise<WizardChannel | null> {
  p.log.step('Telegram Setup')

  const hasTokenResult = await p.select({
    message: 'Do you have a Telegram bot token?',
    options: [
      { value: 'yes' as const, label: 'Yes, I have a token' },
      { value: 'no' as const, label: 'No, help me create one' },
      { value: 'skip' as const, label: 'Skip Telegram for now' },
    ],
  })
  bail(hasTokenResult)
  const hasToken: string = hasTokenResult

  if (hasToken === 'skip') return null

  if (hasToken === 'no') {
    p.note(
      [
        '1. Open Telegram and search for @BotFather',
        '2. Send /newbot',
        '3. Follow the prompts to name your bot',
        '4. BotFather will give you a token — copy it',
      ].join('\n'),
      'Create a Telegram Bot',
    )
  }

  // Check environment first
  const existingToken = process.env.TELEGRAM_BOT_TOKEN
  if (existingToken) {
    const useExistingResult = await p.confirm({
      message: 'Found TELEGRAM_BOT_TOKEN in environment. Use it?',
      initialValue: true,
    })
    bail(useExistingResult)
    if (useExistingResult) {
      const ownerIdResult = await p.text({
        message: 'Your Telegram user ID (message @userinfobot to find it)',
        placeholder: '123456789',
        validate: (val) =>
          val && /^\d{5,15}$/.test(val.trim()) ? undefined : 'Must be a numeric Telegram user ID',
      })
      bail(ownerIdResult)
      return { type: 'telegram', botToken: existingToken, ownerId: ownerIdResult }
    }
  }

  const tokenResult = await p.password({
    message: 'Telegram bot token',
    validate: (val) =>
      val && /^\d+:[A-Za-z0-9_-]{20,}$/.test(val.trim())
        ? undefined
        : 'Must be in format: 123456:ABCdefGHI...',
  })
  bail(tokenResult)

  const ownerIdResult = await p.text({
    message: 'Your Telegram user ID (message @userinfobot to find it)',
    placeholder: '123456789',
    validate: (val) =>
      val && /^\d{5,15}$/.test(val.trim()) ? undefined : 'Must be a numeric Telegram user ID',
  })
  bail(ownerIdResult)

  p.log.success('Telegram configured.')
  return { type: 'telegram', botToken: tokenResult, ownerId: ownerIdResult }
}
