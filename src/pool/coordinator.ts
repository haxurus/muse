import {randomUUID} from 'node:crypto';
import {HttpError} from '../control/http.js';
import {KeyedLock, ReplayGuard} from './concurrency.js';
import {COMMAND_TTL_MS, parsePoolCommand, type PlaybackEnvelope, type PlaybackReply, type PlaybackState, type PoolCommand} from './protocol.js';

export type PoolTransport = {
  state: (workerId: string, guildId: string) => Promise<PlaybackState>;
  reserve: (workerId: string, envelope: PlaybackEnvelope) => Promise<PlaybackState>;
  execute: (workerId: string, envelope: PlaybackEnvelope) => Promise<PlaybackReply>;
};
type Reservation = {envelope: PlaybackEnvelope; inFlight: boolean};
type Observed = {workerId: string; state?: PlaybackState};

export default class PoolCoordinator {
  private readonly channelLocks = new KeyedLock();
  private readonly guildLocks = new KeyedLock();
  private readonly replay = new ReplayGuard<PlaybackReply>();
  private readonly reservations = new Map<string, Reservation>();

  constructor(
    private readonly workerIds: readonly string[],
    private readonly transport: PoolTransport,
    private readonly eligibleWorkers: (command: PoolCommand) => readonly string[],
  ) {}

  async execute(input: unknown): Promise<PlaybackReply> {
    const command = parsePoolCommand(input);
    return this.replay.run(`${command.guildId}/${command.id}`, JSON.stringify(command), async () => {
      if (command.action === 'players') {
        return this.players(command);
      }

      return this.channelLocks.run(`${command.guildId}/${command.voiceChannelId}`, async () => this.dispatch(command));
    });
  }

  private async observe(guildId: string): Promise<Observed[]> {
    return Promise.all(this.workerIds.map(async workerId => {
      try {
        const state = await this.transport.state(workerId, guildId);
        if (state.workerId !== workerId || state.guildId !== guildId) {
          throw new Error('Invalid worker scope');
        }

        return {workerId, state};
      } catch {
        return {workerId};
      }
    }));
  }

  private async dispatch(command: PoolCommand): Promise<PlaybackReply> {
    const {workerId, envelope} = await this.guildLocks.run(command.guildId, async () => this.allocate(command));
    const key = `${command.guildId}/${workerId}`;
    try {
      // A worker-side reservation is acknowledged before any audio command is
      // sent. A restarted coordinator can discover this claim independently.
      const claimed = await this.transport.reserve(workerId, envelope);
      if (claimed.workerId !== workerId || claimed.guildId !== command.guildId
        || claimed.instanceId !== envelope.instanceId || claimed.leaseId !== envelope.leaseId
        || claimed.channelId !== command.voiceChannelId || !claimed.ready) {
        throw new Error('Invalid reservation acknowledgement');
      }

      const result = await this.transport.execute(workerId, envelope);
      if (result.requestId !== command.id || result.guildId !== command.guildId || result.workerId !== workerId) {
        throw new Error('Invalid worker result');
      }

      this.reservations.delete(key);
      return result;
    } catch (error: unknown) {
      if (error instanceof HttpError && error.statusCode < 500) {
        this.reservations.delete(key);
        throw error;
      }

      const reservation = this.reservations.get(key);
      if (reservation) {
        reservation.inFlight = false;
      }

      // Never retry a playback mutation after an ambiguous HTTP timeout.
      throw new HttpError(503, 'Esito del comando incerto. Controlla /players e /queue prima di ripetere /play.');
    }
  }

  private async allocate(command: PoolCommand): Promise<{workerId: string; envelope: PlaybackEnvelope}> {
    const observed = await this.observe(command.guildId);
    this.reconcile(command.guildId, observed);
    const claims = observed.filter(item => item.state?.channelId === command.voiceChannelId
      && (item.state.connected || item.state.busy || item.state.leaseId !== null));
    if (claims.length > 1) {
      throw new HttpError(409, 'Piu player risultano assegnati alla stessa vocale. Serve una verifica amministrativa.');
    }

    let selected: Observed | undefined = claims[0];
    if (selected) {
      if (!selected.state?.ready || selected.state.busy || !selected.state.connected || !selected.state.leaseId) {
        throw new HttpError(409, 'Il player della vocale non e ancora disponibile.');
      }
    } else {
      const pending = [...this.reservations.values()].some(reservation =>
        reservation.envelope.command.guildId === command.guildId
        && reservation.envelope.command.voiceChannelId === command.voiceChannelId);
      if (pending) {
        throw new HttpError(409, 'Prenotazione ancora in verifica: nessun secondo bot verra assegnato.');
      }

      if (command.action !== 'play' && command.action !== 'join') {
        throw new HttpError(404, 'Nessun player attivo nella tua vocale. Usa /play o /join.');
      }

      // An unreachable worker may still own this voice channel after restart.
      if (observed.some(item => !item.state || !item.state.ready)) {
        throw new HttpError(503, 'Stato del pool incompleto. Nuove assegnazioni sospese fino al recupero dei worker.');
      }

      const eligible = new Set(this.eligibleWorkers(command));
      selected = observed.find(item => eligible.has(item.workerId) && item.state?.present
        && !item.state.connected && !item.state.busy && item.state.leaseId === null
        && !this.reservations.has(`${command.guildId}/${item.workerId}`));
      if (!selected) {
        throw new HttpError(409, 'Nessun bot libero nel gruppo previsto per questa vocale.');
      }
    }

    const state = selected.state!;
    const key = `${command.guildId}/${selected.workerId}`;
    if (this.reservations.get(key)?.inFlight) {
      throw new HttpError(409, 'Operazione gia in corso su questo player.');
    }

    const envelope: PlaybackEnvelope = {
      command,
      instanceId: state.instanceId,
      leaseId: state.leaseId ?? randomUUID(),
      deadline: Date.now() + COMMAND_TTL_MS,
    };
    this.reservations.set(key, {envelope, inFlight: true});
    return {workerId: selected.workerId, envelope};
  }

  private reconcile(guildId: string, observed: Observed[]): void {
    for (const item of observed) {
      const key = `${guildId}/${item.workerId}`;
      const reservation = this.reservations.get(key);
      if (!reservation || reservation.inFlight || !item.state?.ready) {
        continue;
      }

      const expired = Date.now() > reservation.envelope.deadline;
      const restarted = item.state.instanceId !== reservation.envelope.instanceId;
      if (restarted || (expired && !item.state.busy && !item.state.connected && item.state.leaseId === null)) {
        this.reservations.delete(key);
      }
    }
  }

  private async players(command: PoolCommand): Promise<PlaybackReply> {
    const observed = await this.observe(command.guildId);
    this.reconcile(command.guildId, observed);
    const lines = observed.map(({workerId, state}) => {
      let status = 'UNAVAILABLE';
      if (state?.ready && state.present) {
        status = state.busy || (!state.connected && state.leaseId !== null) || this.reservations.has(`${command.guildId}/${workerId}`)
          ? 'RESERVED'
          : state.connected ? state.status : 'FREE';
      }

      const here = state?.channelId === command.voiceChannelId ? ' (questa vocale)' : '';
      return `${workerId}: ${status}${here}`;
    });
    return {requestId: command.id, guildId: command.guildId, workerId: 'pool', text: lines.join('\n')};
  }
}
