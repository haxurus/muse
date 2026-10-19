/** A bot that was healthy is reported down after this many failed checks in a row (one check per minute). */
export const DOWN_AFTER_FAILED_CHECKS = 2;

/** One bot's health at one check: reachable and Discord ready. */
export type WorkerHealthObservation = {
  workerId: string;
  healthy: boolean;
};

/** An alert to send now: the bot went down (`since` = first failed check) or came back (`since` = when it went down). */
export type WorkerHealthTransition = {
  type: 'down' | 'recovered';
  workerId: string;
  /** ISO 8601. */
  since: string;
};

type WorkerHealthState = {
  /** Healthy at least once since the orchestrator started; a bot never seen healthy never alerts. */
  everHealthy: boolean;
  failedChecks: number;
  firstFailedAt: string | null;
  /** Set while a down alert is outstanding. */
  downSince: string | null;
};

/**
 * Turns successive health checks into down and recovered alerts. In memory only: a restarted
 * orchestrator starts from scratch, so bots that were already down do not alert.
 */
export class WorkerHealthTracker {
  private readonly states = new Map<string, WorkerHealthState>();

  /** Feed one round of checks taken at `at`; returns the alerts that are due. */
  observe(observations: WorkerHealthObservation[], at: string): WorkerHealthTransition[] {
    const transitions: WorkerHealthTransition[] = [];
    for (const {workerId, healthy} of observations) {
      const state = this.stateOf(workerId);
      if (healthy) {
        state.everHealthy = true;
        state.failedChecks = 0;
        state.firstFailedAt = null;
        const {downSince} = state;
        if (downSince !== null) {
          state.downSince = null;
          transitions.push({type: 'recovered', workerId, since: downSince});
        }
      } else if (state.everHealthy && state.downSince === null) {
        const since = state.firstFailedAt ?? at;
        state.failedChecks += 1;
        state.firstFailedAt = since;
        if (state.failedChecks >= DOWN_AFTER_FAILED_CHECKS) {
          state.downSince = since;
          transitions.push({type: 'down', workerId, since});
        }
      }
    }

    return transitions;
  }

  /** When the outstanding down alert of a bot began, or `null` when the bot is not alerting. */
  downSince(workerId: string): string | null {
    return this.states.get(workerId)?.downSince ?? null;
  }

  private stateOf(workerId: string): WorkerHealthState {
    const existing = this.states.get(workerId);
    if (existing) {
      return existing;
    }

    const state: WorkerHealthState = {everHealthy: false, failedChecks: 0, firstFailedAt: null, downSince: null};
    this.states.set(workerId, state);
    return state;
  }
}
