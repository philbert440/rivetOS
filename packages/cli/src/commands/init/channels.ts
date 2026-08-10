/**
 * Phase 4: Channel configuration.
 *
 * Phase 5 removed social channel plugins (telegram / discord / voice-discord).
 * Human interaction is Hub (gateway + rivethub). Init no longer collects bot
 * tokens — optional agent mesh is configured by hand if needed.
 */

import * as p from '@clack/prompts'
import type { WizardChannel } from './types.js'

export async function configureChannels(): Promise<WizardChannel[]> {
  // Keep async for wizard step API parity with other configure* steps.
  await Promise.resolve()
  p.log.info(
    'Human UX is RivetHub (gateway clients). Social channel bots (Telegram, Discord, voice) were removed in Phase 5.',
  )
  p.log.info('Optional agent-to-agent mesh: add channels.agent in config.yaml after setup.')
  return []
}
