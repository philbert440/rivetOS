/**
 * Voice Plugin — Discord voice channel integration via xAI Realtime API.
 * Manages bot lifecycle: slash commands, auto-join/leave, voice session creation.
 */

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  type VoiceState,
} from 'discord.js';
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { VoiceSession } from './voice-session.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface VoicePluginConfig {
  discordToken: string;
  xaiApiKey: string;
  guildId: string;
  allowedUsers: string[];
  voice?: string;
  instructions?: string;
  silenceDurationMs?: number;
  sampleRate?: number;
  transcriptDir?: string;
  leaveGracePeriodMs?: number;
  xaiCollectionId?: string;
  postgresConnectionString?: string;
  /** Shared pg Pool — passed from boot.ts, NOT created per session */
  sharedPool?: import('pg').Pool;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class VoicePlugin {
  private client: Client;
  private config: VoicePluginConfig;
  private session: VoiceSession | null = null;
  private leaveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: VoicePluginConfig) {
    this.config = {
      voice: 'Ara',
      silenceDurationMs: 1500,
      sampleRate: 24000,
      transcriptDir: 'transcripts',
      leaveGracePeriodMs: 10000,
      ...config,
    };

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.client.once('ready', async () => {
      console.log(`[Voice] Bot ready: ${this.client.user?.tag}`);
      await this.registerCommands();
      await this.startupScan();
    });

    this.client.on('voiceStateUpdate', (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState);
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'voice') return;
      await this.handleSlashCommand(interaction);
    });
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
          sub.setName('voice').setDescription('Change AI voice')
            .addStringOption((opt) =>
              opt.setName('name').setDescription('Voice name (Rex, Ara, Sal, Eve, Leo)').setRequired(true)),
        ),
    ];

    const guild = this.client.guilds.cache.get(this.config.guildId);
    if (guild) await guild.commands.set(commands);
  }

  private async handleSlashCommand(interaction: any): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'join': {
        const member = interaction.member as any;
        const channel = member.voice?.channel;
        if (!channel) return interaction.reply({ content: 'You need to be in a voice channel.', ephemeral: true });
        if (this.session) return interaction.reply({ content: 'Already connected.', ephemeral: true });
        try {
          await this.joinChannel(channel.id, channel.guild.id, channel.guild.voiceAdapterCreator);
          await interaction.reply('Joined.');
        } catch (err: any) {
          console.error('[Voice] Join failed:', err.message);
          await interaction.reply({ content: 'Failed to join.', ephemeral: true });
        }
        break;
      }
      case 'leave': {
        if (!this.session) return interaction.reply({ content: 'Not connected.', ephemeral: true });
        this.destroySession();
        await interaction.reply('Left.');
        break;
      }
      case 'status': {
        if (!this.session) return interaction.reply({ content: 'Not connected.', ephemeral: true });
        await interaction.reply(this.session.getStatus());
        break;
      }
      case 'voice': {
        if (!this.session) return interaction.reply({ content: 'Not connected.', ephemeral: true });
        const name = interaction.options.getString('name')!;
        this.session.setVoice(name);
        await interaction.reply(`Voice changed to ${name}.`);
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Auto-join / Auto-leave
  // -----------------------------------------------------------------------

  private async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const userId = newState.member?.id ?? oldState.member?.id ?? '';
    if (!this.config.allowedUsers.includes(userId)) return;

    const joined = newState.channelId && newState.channelId !== oldState.channelId;
    const left = oldState.channelId && oldState.channelId !== newState.channelId;

    if (joined && !this.session) {
      const channel = newState.channel;
      if (!channel) return;
      if (this.leaveTimeout) { clearTimeout(this.leaveTimeout); this.leaveTimeout = null; }
      try {
        console.log(`[Voice] Auto-joining ${channel.name} (${newState.member?.user.tag})`);
        await this.joinChannel(channel.id, channel.guild.id, channel.guild.voiceAdapterCreator);
      } catch (err: any) {
        console.error('[Voice] Auto-join failed:', err.message);
      }
    }

    if (left && this.session) {
      const channel = oldState.channel;
      if (!channel) return;
      const allowedStillIn = channel.members.some(
        (m) => this.config.allowedUsers.includes(m.id) && !m.user.bot,
      );
      if (allowedStillIn) return;

      console.log('[Voice] All allowed users left, starting grace period');
      if (this.leaveTimeout) clearTimeout(this.leaveTimeout);
      this.leaveTimeout = setTimeout(() => {
        const ch = oldState.guild.channels.cache.get(oldState.channelId!);
        if (ch && 'members' in ch) {
          const stillIn = (ch as any).members.some(
            (m: any) => this.config.allowedUsers.includes(m.id) && !m.user.bot,
          );
          if (stillIn) return;
        }
        console.log('[Voice] Auto-disconnecting');
        this.destroySession();
        this.leaveTimeout = null;
      }, this.config.leaveGracePeriodMs);
    }
  }

  // -----------------------------------------------------------------------
  // Startup Scan
  // -----------------------------------------------------------------------

  private async startupScan(): Promise<void> {
    try {
      const guild = this.client.guilds.cache.get(this.config.guildId);
      if (!guild) return;
      for (const [, vs] of guild.voiceStates.cache) {
        if (vs.channelId && this.config.allowedUsers.includes(vs.id) && !vs.member?.user.bot && !this.session) {
          const channel = guild.channels.cache.get(vs.channelId);
          if (!channel) continue;
          console.log(`[Voice] Startup: ${vs.member?.user.tag} in ${channel.name}, auto-joining`);
          await this.joinChannel(channel.id, guild.id, guild.voiceAdapterCreator);
          break;
        }
      }
    } catch (err: any) {
      console.error('[Voice] Startup scan failed:', err.message);
    }
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  private async joinChannel(channelId: string, guildId: string, adapterCreator: any): Promise<void> {
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: false,
      decryptionFailureTolerance: 100,
    });

    connection.on('stateChange', (_old: any, _new: any) => {
      console.log(`[Voice] VC: ${_old.status} → ${_new.status}`);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    this.session = new VoiceSession(connection, this.config);
    console.log('[Voice] Session active');
  }

  private destroySession(): void {
    this.session?.destroy();
    this.session = null;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    console.log('[Voice] Starting...');
    await this.client.login(this.config.discordToken);
  }

  async stop(): Promise<void> {
    console.log('[Voice] Stopping...');
    this.destroySession();
    if (this.leaveTimeout) clearTimeout(this.leaveTimeout);
    this.client.destroy();
  }
}
