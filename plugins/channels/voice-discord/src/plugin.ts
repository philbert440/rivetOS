/**
 * Voice Plugin — Discord voice channel integration via xAI Realtime API.
 * Manages bot lifecycle: slash commands, auto-join/leave, voice session creation.
 */

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type VoiceState,
  type GuildMember,
  type Guild,
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
  StreamEvent,
} from '@rivetos/types'
import { VoiceSession } from './voice-session.js'
import { LocalVoiceSession } from './local-voice-session.js'
import { splitClauses } from './local-voice.js'
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
  /**
   * Restrict auto-join to a single voice channel id. When set, the bot only
   * follows allowed users into THIS channel and ignores all others (e.g. keep
   * #general clear). Unset = join whichever channel an allowed user enters.
   */
  voiceChannelId?: string
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

  // Streaming-TTS state (local provider). streamBuf accumulates the agent's
  // live text for the current turn; complete clauses are spoken as they arrive.
  // Scoped by currentTurnId so a barge-in (/interrupt) turn never speaks the
  // aborted turn's leftover text. turnActive => a turn is generating (=> next
  // utterance interrupts it).
  private streamBuf = ''
  private currentTurnId = ''
  private turnActive = false

  get isLocal(): boolean {
    return this.config.provider === 'local'
  }

  constructor(config: VoicePluginConfig) {
    this.config = {
      voice: 'Ara',
      silenceDurationMs: config.provider === 'local' ? 900 : 1500,
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
      // Restricted to a specific voice channel — ignore joins elsewhere.
      if (this.config.voiceChannelId && newState.channelId !== this.config.voiceChannelId) return
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
      const channelId = oldState.channelId
      if (!channelId) return
      // Use voice states (we have the GuildVoiceStates intent), NOT channel.members,
      // which is empty without the privileged GuildMembers intent — that false
      // emptiness made the bot think everyone left and disconnect after one turn.
      if (this.allowedUserInChannel(oldState.guild, channelId)) return

      console.log('[Voice] All allowed users left, starting grace period')
      if (this.leaveTimeout) clearTimeout(this.leaveTimeout)
      this.leaveTimeout = setTimeout(() => {
        if (this.allowedUserInChannel(oldState.guild, channelId)) {
          this.leaveTimeout = null
          return
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

  /** Any allowed (non-bot) user currently in this voice channel, via voice states. */
  private allowedUserInChannel(guild: Guild, channelId: string): boolean {
    for (const [, vs] of guild.voiceStates.cache) {
      if (vs.channelId === channelId && this.config.allowedUsers.includes(vs.id)) return true
    }
    return false
  }

  private async startupScan(): Promise<void> {
    try {
      const guild = this.client.guilds.cache.get(this.config.guildId)
      if (!guild) return
      for (const [, vs] of guild.voiceStates.cache) {
        if (
          vs.channelId &&
          (!this.config.voiceChannelId || vs.channelId === this.config.voiceChannelId) &&
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
        {
          onUserUtterance: (userId, text) => this.emitInbound(userId, text),
          onSpeechStart: () => {
            /* audio already stopped in-session; the turn is aborted when the
               utterance completes (emitInbound emits /interrupt) */
          },
        },
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

  /**
   * Live token deltas for the active turn. Accumulate text and speak complete
   * clauses as they arrive (low time-to-first-audio + stays under the TTS
   * length cap). Scoped to the current turn's message id so a superseded
   * (interrupted) turn's tail never bleeds into the next one.
   */
  onStreamEvent(message: InboundMessage, event: StreamEvent): void {
    if (!(this.session instanceof LocalVoiceSession)) return
    if (message.channelId !== this.session.channelId) return
    if (message.id !== this.currentTurnId) return // stale/superseded turn
    if (event.type === 'text') {
      this.streamBuf += event.content
      const { clauses, rest } = splitClauses(this.streamBuf)
      for (const c of clauses) this.session.enqueueSpeech(c)
      this.streamBuf = rest
    } else if (event.type === 'interrupt' || event.type === 'error') {
      this.streamBuf = '' // turn abandoned — don't speak the partial tail
    }
  }

  /** Build an InboundMessage from a transcript and push it into the turn pipeline. */
  private emitInbound(userId: string, text: string): void {
    console.log(
      `[VoiceDBG] emit handler=${!!this.messageHandler} turnActive=${this.turnActive} text=${JSON.stringify(text.slice(0, 40))}`,
    )
    if (!this.messageHandler) return
    const channelId = this.session instanceof LocalVoiceSession ? this.session.channelId : this.id
    // Barge-in: if a turn is mid-flight, /interrupt aborts it and runs this
    // utterance as the new turn (reusing this message id, so streaming matches).
    const bargeIn = this.turnActive
    const id = `voice_${Date.now()}`
    this.streamBuf = ''
    this.currentTurnId = id
    this.turnActive = true
    const message: InboundMessage = {
      id,
      userId,
      channelId,
      chatType: 'voice',
      text: bargeIn ? `/interrupt ${text}` : text,
      platform: this.platform,
      agent: this.config.agentId,
      // Voice runs thinking-off to cut latency — the 27B otherwise reasons on
      // every turn (seconds of dead air). Text keeps the agent's level.
      metadata: { thinking: 'off' },
      timestamp: Date.now(),
    }
    console.log(`[VoiceDBG] dispatch text=${JSON.stringify(message.text.slice(0, 50))}`)
    void this.messageHandler(message)
      .then(() => console.log('[VoiceDBG] handler resolved'))
      .catch((err: unknown) => {
        console.error('[Voice] turn handler error:', (err as Error).message)
      })
  }

  /**
   * Finalize a turn (from the turn:after hook). Speak any trailing text that
   * didn't end on clause punctuation. Skip aborted turns (interrupted/partial).
   */
  onTurnComplete(sessionId: string, aborted: boolean): void {
    if (!(this.session instanceof LocalVoiceSession)) return
    const match = sessionId.split(':')[0] === this.session.channelId
    console.log(
      `[VoiceDBG] turnComplete sid=${sessionId} aborted=${aborted} match=${match} turnActive=${this.turnActive}`,
    )
    if (!match) return
    // Always clear turnActive — an aborted turn that left it `true` would wedge
    // every later utterance into barge-in mode and break the channel.
    this.turnActive = false
    if (aborted) {
      this.streamBuf = '' // superseded by an interrupt — its tail is abandoned
      return
    }
    const tail = this.streamBuf.trim()
    this.streamBuf = ''
    if (tail) this.session.enqueueSpeech(tail)
  }
}
