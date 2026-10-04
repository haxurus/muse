import {randomUUID} from 'node:crypto';
import {Client, PermissionFlagsBits, VoiceChannel} from 'discord.js';
import {HttpError} from '../control/http.js';
import PlayerManager from '../managers/player.js';
import AddQueryToQueue from '../services/add-query-to-queue.js';
import {STATUS} from '../services/player.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {ReplayGuard} from './concurrency.js';
import {parseEnvelope, type PlaybackEnvelope, type PlaybackReply, type PlaybackState, type PoolCommand} from './protocol.js';

type Lease = {id: string; channelId: string};
type WorkerDependencies = {client: Client; players: PlayerManager; media: AddQueryToQueue};
const displayTitle = (title: string): string => title.replace(/[\r\n`*_~<>]/gu, ' ').slice(0, 100);

export default class PoolWorker {
  private readonly instanceId = randomUUID();
  private readonly replay = new ReplayGuard<PlaybackReply>();
  private readonly leases = new Map<string, Lease>();
  private readonly busy = new Set<string>();
  private closed = false;

  constructor(private readonly workerId: string, private readonly dependencies: WorkerDependencies) {}

  state(guildId: string): PlaybackState {
    const {client, players} = this.dependencies;
    const player = players.snapshot().find(candidate => candidate.guildId === guildId);
    const guild = client.guilds.cache.get(guildId);
    const actualChannelId = client.user ? guild?.voiceStates.cache.get(client.user.id)?.channelId ?? null : null;
    const connected = Boolean(player?.connected || actualChannelId);
    const busy = this.busy.has(guildId);
    if (!busy && !connected) {
      this.leases.delete(guildId);
    }

    const lease = this.leases.get(guildId);
    const channelId = actualChannelId ?? player?.channelId ?? (busy ? lease?.channelId ?? null : null);
    const status = player?.status === 'PLAYING' ? 'PLAYING' : player?.status === 'PAUSED' ? 'PAUSED' : 'IDLE';
    return {
      workerId: this.workerId, guildId, instanceId: this.instanceId,
      present: client.guilds.cache.has(guildId), ready: client.isReady() && !this.closed,
      connected, busy, channelId, leaseId: lease?.id ?? null, status,
    };
  }

  execute(input: unknown): Promise<PlaybackReply> {
    const envelope = parseEnvelope(input);
    const {command} = envelope;
    return this.replay.run(`${command.guildId}/${command.id}`, JSON.stringify(envelope), async () => this.claim(envelope));
  }

  invalidate(guildId: string): void {
    this.leases.delete(guildId);
    this.dependencies.players.get(guildId).stop();
  }

  close(): void {
    this.closed = true;
    for (const guildId of this.leases.keys()) {
      this.dependencies.players.get(guildId).stop();
    }
  }

  private async claim(envelope: PlaybackEnvelope): Promise<PlaybackReply> {
    const {command} = envelope;
    const state = this.state(command.guildId);
    if (!state.ready || envelope.instanceId !== this.instanceId) {
      throw new HttpError(409, 'Il worker e stato riavviato o non e pronto.');
    }

    if (envelope.deadline <= Date.now()) {
      throw new HttpError(409, 'Prenotazione scaduta.');
    }

    if (this.busy.size >= 32 || this.busy.has(command.guildId)
      || (state.channelId !== null && state.channelId !== command.voiceChannelId)
      || (state.connected && state.leaseId !== envelope.leaseId)) {
      throw new HttpError(409, 'Il worker e occupato o appartiene a un altro canale.');
    }

    if (command.action === 'players') {
      throw new HttpError(400, 'Comando riservato al coordinatore.');
    }

    const newlyAssigned = !state.connected;
    if (newlyAssigned && command.action !== 'play' && command.action !== 'join') {
      throw new HttpError(409, 'La sessione vocale e terminata.');
    }

    this.leases.set(command.guildId, {id: envelope.leaseId, channelId: command.voiceChannelId});
    this.busy.add(command.guildId);
    try {
      return await this.perform(envelope, newlyAssigned);
    } catch (error: unknown) {
      if (newlyAssigned) {
        this.dependencies.players.get(command.guildId).stop();
      }

      if (error instanceof HttpError) {
        throw error;
      }

      // Media/library errors can contain provider URLs or credentials.
      throw new HttpError(422, 'Riproduzione non riuscita. Controlla /queue prima di ripetere la richiesta.');
    } finally {
      this.busy.delete(command.guildId);
      this.state(command.guildId);
    }
  }

  private assertActive(envelope: PlaybackEnvelope): void {
    const {command} = envelope;
    const {client} = this.dependencies;
    const guild = client.guilds.cache.get(command.guildId);
    const lease = this.leases.get(command.guildId);
    if (this.closed || !client.isReady() || Date.now() >= envelope.deadline
      || lease?.id !== envelope.leaseId || lease.channelId !== command.voiceChannelId
      || guild?.voiceStates.cache.get(command.userId)?.channelId !== command.voiceChannelId) {
      throw new HttpError(409, 'Richiesta scaduta oppure utente non piu nella vocale.');
    }
  }

  private async context(envelope: PlaybackEnvelope): Promise<VoiceChannel> {
    this.assertActive(envelope);
    const {command} = envelope;
    const {client} = this.dependencies;
    const guild = client.guilds.cache.get(command.guildId)!;
    const voice = guild.channels.cache.get(command.voiceChannelId);
    const text = guild.channels.cache.get(command.textChannelId);
    const member = await guild.members.fetch(command.userId);
    const me = guild.members.me;
    this.assertActive(envelope);
    if (!(voice instanceof VoiceChannel) || voice.parentId !== command.categoryId
      || !text?.isTextBased() || member.user.bot || !me
      || !voice.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
      || !voice.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
      || !text.permissionsFor(member).has(PermissionFlagsBits.ViewChannel)) {
      throw new HttpError(403, 'Permessi o contesto del canale non validi.');
    }

    return voice;
  }

  private async perform(envelope: PlaybackEnvelope, newlyAssigned: boolean): Promise<PlaybackReply> {
    const {command} = envelope;
    const voice = await this.context(envelope);
    const player = this.dependencies.players.get(command.guildId);
    if (newlyAssigned) {
      // Never carry a disconnected room's queue into somebody else's channel.
      player.stop();
    }

    let message: string;
    if (command.action === 'play') {
      const settings = await getGuildSettings(command.guildId);
      const songs = await this.dependencies.media.resolveForPool(command.query!, Math.min(settings.playlistLimit, 500));
      await this.context(envelope);
      if (songs.length === 0) {
        throw new HttpError(422, 'Nessun brano trovato.');
      }

      if (player.queueSize() + songs.length + (player.getCurrent() ? 1 : 0) > 1000) {
        throw new HttpError(409, 'Limite di 1000 brani per sessione raggiunto.');
      }

      if (!player.voiceConnection) {
        await player.connect(voice);
      } else {
        await player.ensureVoiceConnectionReady();
      }

      this.assertActive(envelope);
      for (const song of songs) {
        player.add({...song, requestedBy: command.userId, addedInChannelId: command.textChannelId});
      }

      if (newlyAssigned || player.status === STATUS.IDLE) {
        await player.play();
      }

      this.assertActive(envelope);
      message = `${songs.length} brani aggiunti. Primo: ${displayTitle(songs[0].title)}`;
    } else if (command.action === 'join') {
      if (!player.voiceConnection) {
        await player.connect(voice);
      }

      this.assertActive(envelope);
      message = 'Player connesso alla tua vocale.';
    } else {
      this.assertActive(envelope);
      if (player.voiceConnection?.joinConfig.channelId !== command.voiceChannelId) {
        throw new HttpError(409, 'La connessione vocale e cambiata.');
      }

      message = await this.control(command);
    }

    return {requestId: command.id, guildId: command.guildId, workerId: this.workerId, text: `${this.workerId}: ${message}`};
  }

  private async control(command: PoolCommand): Promise<string> {
    const player = this.dependencies.players.get(command.guildId);
    switch (command.action) {
      case 'pause':
        if (player.status === STATUS.PLAYING) {
          player.pause();
        }

        return 'Riproduzione in pausa.';
      case 'resume':
        if (player.status !== STATUS.PLAYING) {
          await player.play();
        }

        return 'Riproduzione ripresa.';
      case 'skip':
        await player.forward(1);
        return 'Brano saltato.';
      case 'stop':
      case 'disconnect':
        player.stop();
        return 'Player disconnesso e coda svuotata.';
      case 'volume':
        player.setVolume(command.volume!);
        return `Volume: ${command.volume!}%.`;
      case 'queue': {
        const current = player.getCurrent();
        const queue = player.getQueue();
        return [`In riproduzione: ${current ? displayTitle(current.title) : 'nessun brano'}`,
          ...queue.slice(0, 10).map((song, index) => `${index + 1}. ${displayTitle(song.title)}`),
          `Brani in attesa: ${queue.length}`].join('\n');
      }

      default:
        throw new HttpError(400, 'Comando non supportato dal player.');
    }
  }
}
