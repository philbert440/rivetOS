/**
 * Voice Plugin — Discord voice channel integration via xAI Realtime API.
 * Manages bot lifecycle: slash commands, auto-join/leave, voice session creation.
 */

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type VoiceBasedChannel,
  type VoiceState,
  type GuildMember,
} from 'discord.js'
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  type DiscordGatewayAdapterCreator,
} from '@discordjs/voice'
import type { VoiceConnectionState } from '@discordjs/voice'
import type {
  Channel,
  InboundMessage,
  OutboundMessage,
  EditResult,
} from '@rivetos/types'
import { VoiceSession } from './voice-session.js'
import { LocalVoiceSession } from './local-voice-session.js'
import type { LocalVoiceConfig } from './local-voice.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface VoicePluginConfig {
  discordToken: string
  xaiApiKey: string
  guildId: string
  allowedUsers: string[]
  voice?: string
  instructions?: string
  silenceDurationMs?: number
  sampleRate?: number
  transcriptDir?: string
  leaveGracePeriodMs?: number
  xaiCollectionId?: string
  postgresConnectionString?: string
  /** Shared postgres pool (avoids creating per-session pools) */
  postgresPool?: import('pg').Pool
  /** Shared pg Pool — passed from boot.ts, NOT created per session */
  sharedPool?: import('pg').Pool
  /**
   * Backend for voice turns. 'xai'/'gemini' = cloud realtime (VoiceSession).
   * 'local' = turn-based via the GERTY stack, routed through the real agent
   * (LocalVoiceSession + this plugin acting as a RivetOS Channel).
   */
  provider?: 'xai' | 'gemini' | 'local'
  /** Local (GERTY) STT/TTS config — required when provider === 'local'. */
  local?: LocalVoiceConfig
  /** Channel id this plugin registers as (local provider). Default 'voice-discord'. */
  channelId?: string
  /** Agent to route voice turns to (local provider). Default 'local'. */
  agentId?: string
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class VoicePlugin implements Channel {
  // --- Channel interface ---
  readonly id: string
  readonly platform = 'voice-discord'

  private client: Client
  private config: VoicePluginConfig
  private session: VoiceSession | LocalVoiceSession | null = null
  private leaveTimeout: ReturnType<typeof setTimeout> | null = null
  private messageHandler?: (message: InboundMessage) => Promise<void>
  private commandHandler?: (command: string, args: string, message: InboundMessage) => Promise<void>

  get isLocal(): boolean {
    return this.config.provider === 'local'
  }

  constructor(config: VoicePluginConfig) {
    this.config = {
      voice: 'Ara',
      silenceDurationMs: config.provider === 'local' ? 1200 : 1500,
      sampleRate: 24000,
      transcriptDir: 'transcripts',
      leaveGracePeriodMs: 10000,
      channelId: 'voice-discord',
      agentId: 'local',
      ...config,
    }
    this.id = this.config.channelId ?? 'voice-discord'

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    })

    this.setupHandlers()
  }

  private setupHandlers(): void {
    this.client.once('ready', () => {
      console.log(`[Voice] Bot ready: ${this.client.user?.tag}`)
      void this.registerCommands()
      void this.startupScan()
    })

    this.client.on('voiceStateUpdate', (oldState, newState) => {
      void this.handleVoiceStateUpdate(oldState, newState)
    })

    this.client.on('interactionCreate', (interaction) => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'voice') return
      void this.handleSlashCommand(interaction)
    })
  }

  // -----------------------------------------------------------------------
  // Slash Commands
  // -----------------------------------------------------------------------

  private async registerCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Voice bot commands')
        .addSubcommand((sub) => sub.setName('join').setDescription('Join voice channel'))
        .addSubcommand((sub) => sub.setName('leave').setDescription('Leave voice channel'))
        .addSubcommand((sub) => sub.setName('status').setDescription('Show session info'))
        .addSubcommand((sub) =>
          sub
            .setName('voice')
            .setDescription('Change AI voice')
            .addStringOption((opt) =>
              opt
                .setName('name')
                .setDescription('Voice name (Rex, Ara, Sal, Eve, Leo)')
                .setRequired(true),
            ),
        ),
    ]

    const guild = this.client.guilds.cache.get(this.config.guildId)
    if (guild) await guild.commands.set(commands)
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand()

    switch (subcommand) {
      case 'join': {
        const member = interaction.member as GuildMember | null
        const channel = member?.voice.channel
        if (!channel) {
          await interaction.reply({
            content: 'You need to be in a voice channel.',
            ephemeral: true,
          })
          return
        }
        if (this.session) {
          await interaction.reply({ content: 'Already connected.', ephemeral: true })
          return
        }
        try {
          await this.joinChannel(channel.id, channel.guild.id, channel.guild.voiceAdapterCreator)
          await interaction.reply('Joined.')
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[Voice] Join failed:', message)
          await interaction.reply({ content: 'Failed to join.', ephemeral: true })
        }
        break
      }
      case 'leave': {
        if (!this.session) {
          await interaction.reply({ content: 'Not connected.', ephemeral: true })
          return
        }
        this.destroySession()
        await interaction.reply('Left.')
        break
      }
      case 'status': {
        if (!this.session) {
          await interaction.reply({ content: 'Not connected.', ephemeral: true })
          return
        }
        await interaction.reply(this.session.getStatus())
        break
      }
      case 'voice': {
        if (!this.session) {
          await interaction.reply({ content: 'Not connected.', ephemeral: true })
          return
        }
        const name = interaction.options.getString('name')!
        this.session.setVoice(name)
        await interaction.reply(`Voice changed to ${name}.`)
        break
      }
    }
  }

  // -----------------------------------------------------------------------
  // Auto-join / Auto-leave
  // -----------------------------------------------------------------------

  private async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const userId = newState.member?.id ?? oldState.member?.id ?? ''
    if (!this.config.allowedUsers.includes(userId)) return

    const joined = newState.channelId && newState.channelId !== oldState.channelId
    const left = oldState.channelId && oldState.channelId !== newState.channelId

    if (joined && !this.session) {
      const channel = newState.channel
      if (!channel) return
      if (this.leaveTimeout) {
        clearTimeout(this.leaveTimeout)
        this.leaveTimeout = null
      }
      try {
        console.log(`[Voice] Auto-joining ${channel.name} (${newState.member?.user.tag})`)
        await this.joinChannel(channel.id, channel.guild.id, channel.guild.voiceAdapterCreator)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[Voice] Auto-join failed:', message)
      }
    }

    if (left && this.session) {
      const channel = oldState.channel
      if (!channel) return
      const allowedStillIn = channel.members.some(
        (m: GuildMember) => this.config.allowedUsers.includes(m.id) && !m.user.bot,
      )
      if (allowedStillIn) return

      console.log('[Voice] All allowed users left, starting grace period')
      if (this.leaveTimeout) clearTimeout(this.leaveTimeout)
      this.leaveTimeout = setTimeout(() => {
        const ch = oldState.guild.channels.cache.get(oldState.channelId!)
        if (ch && 'members' in ch) {
          const members = (ch as VoiceBasedChannel).members
          const stillIn = members.some(
            (m: GuildMember) => this.config.allowedUsers.includes(m.id) && !m.user.bot,
          )
          if (stillIn) return
        }
        console.log('[Voice] Auto-disconnecting')
        this.destroySession()
        this.leaveTimeout = null
      }, this.config.leaveGracePeriodMs)
    }
  }

  // -----------------------------------------------------------------------
  // Startup Scan
  // -----------------------------------------------------------------------

  private async startupScan(): Promise<void> {
    try {
      const guild = this.client.guilds.cache.get(this.config.guildId)
      if (!guild) return
      for (const [, vs] of guild.voiceStates.cache) {
        if (
          vs.channelId &&
          this.config.allowedUsers.includes(vs.id) &&
          !vs.member?.user.bot &&
          !this.session
        ) {
          const channel = guild.channels.cache.get(vs.channelId)
          if (!channel) continue
          console.log(`[Voice] Startup: ${vs.member?.user.tag} in ${channel.name}, auto-joining`)
          await this.joinChannel(channel.id, guild.id, guild.voiceAdapterCreator)
          break
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[Voice] Startup scan failed:', message)
    }
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  private async joinChannel(
    channelId: string,
    guildId: string,
    adapterCreator: DiscordGatewayAdapterCreator,
  ): Promise<void> {
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: false,
      decryptionFailureTolerance: 100,
    })

    connection.on('stateChange', (oldS: VoiceConnectionState, newS: VoiceConnectionState) => {
      console.log(`[Voice] VC: ${oldS.status} → ${newS.status}`)
    })

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000)

    if (this.config.provider === 'local') {
      if (!this.config.local) throw new Error('provider=local requires `local` config')
      this.session = new LocalVoiceSession(
        connection,
        {
          local: this.config.local,
          allowedUsers: this.config.allowedUsers,
          silenceDurationMs: this.config.silenceDurationMs,
          transcriptDir: this.config.transcriptDir,
        },
        { onUserUtterance: (userId, text) => this.emitInbound(userId, text) },
      )
      console.log('[Voice] Local session active (GERTY stack, via agent)')
    } else {
      this.session = new VoiceSession(connection, this.config)
      console.log('[Voice] Session active')
    }
  }

  private destroySession(): void {
    this.session?.destroy()
    this.session = null
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    console.log('[Voice] Starting...')
    await this.client.login(this.config.discordToken)
  }

  async stop(): Promise<void> {
    console.log('[Voice] Stopping...')
    this.destroySession()
    if (this.leaveTimeout) clearTimeout(this.leaveTimeout)
    await this.client.destroy()
  }

  // -----------------------------------------------------------------------
  // Channel interface (local provider) — voice is a RivetOS Channel so turns
  // run through the real agent. A transcribed utterance becomes an
  // InboundMessage; the agent's reply is spoken from the turn:after hook
  // (see speakResponse), NOT from streaming. send()/edit() therefore swallow
  // streaming partials and the final text — they exist only to satisfy the
  // StreamManager without voicing half-formed output.
  // -----------------------------------------------------------------------

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onCommand(
    handler: (command: string, args: string, message: InboundMessage) => Promise<void>,
  ): void {
    this.commandHandler = handler
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async send(_message: OutboundMessage): Promise<string | null> {
    // No-op: the spoken reply is produced by speakResponse() from turn:after.
    return 'voice-stream'
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async edit(
    _channelId: string,
    messageId: string,
    _text: string,
    _overflowIds?: string[],
  ): Promise<EditResult | null> {
    // No-op for the same reason as send().
    return { messageIds: [messageId] }
  }

  /** Build an InboundMessage from a transcript and push it into the turn pipeline. */
  private emitInbound(userId: string, text: string): void {
    if (!this.messageHandler) return
    const channelId = this.session instanceof LocalVoiceSession ? this.session.channelId : this.id
    const message: InboundMessage = {
      id: `voice_${Date.now()}`,
      userId,
      channelId,
      chatType: 'voice',
      text,
      platform: this.platform,
      agent: this.config.agentId,
      timestamp: Date.now(),
    }
    void this.messageHandler(message).catch((err: unknown) => {
      console.error('[Voice] turn handler error:', (err as Error).message)
    })
  }

  /**
   * Speak the agent's final response. Called from a turn:after hook with the
   * full response and the sessionId (`${channelId}:${userId}`). We only speak
   * when the sessionId belongs to the active local voice channel.
   */
  speakResponse(sessionId: string, response: string, aborted: boolean): void {
    if (aborted || !response.trim()) return
    if (!(this.session instanceof LocalVoiceSession)) return
    const channelId = sessionId.split(':')[0]
    if (channelId !== this.session.channelId) return
    void this.session.speak(response)
  }
}
