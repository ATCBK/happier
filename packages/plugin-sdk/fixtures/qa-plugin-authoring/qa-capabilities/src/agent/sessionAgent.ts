import type {
  AgentRuntimeFactory,
  AgentSessionDisposeReason,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';

type RuntimeEventInput = AgentSessionRuntimeEvent extends infer Event
  ? Event extends AgentSessionRuntimeEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never
  : never;

type ActiveTurn = Readonly<{
  turnId: string;
  controller: AbortController;
}>;

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

function disposalCause(reason: AgentSessionDisposeReason) {
  switch (reason) {
    case 'host_shutdown': return 'hostShutdown' as const;
    case 'runtime_recovery': return 'runtimeRecovery' as const;
    case 'plugin_deactivated':
    case 'session_closed': return 'sessionDispose' as const;
  }
}

function createSessionRuntime(
  context: AgentSessionRuntimeContext,
  providerSessionId: string,
): AgentSessionRuntime {
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  let sequence = 0;
  let activeTurn: ActiveTurn | null = null;
  let disposed = false;
  let providerIdentityPublished = false;

  const emit = (event: RuntimeEventInput): void => {
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      sessionId: context.session.id,
      emittedAtMs: Date.now(),
    }) as AgentSessionRuntimeEvent;
    for (const listener of Array.from(listeners)) {
      try { listener(published); } catch {
        // One observer must not prevent later host projections receiving the event.
      }
    }
  };

  const cancelTurn = (turn: ActiveTurn, cause: 'user' | 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery'): void => {
    if (activeTurn !== turn) return;
    activeTurn = null;
    emit({ kind: 'turn-cancelled', turnId: turn.turnId, cause });
  };

  const executeTurn = async (turn: ActiveTurn, prompt: string): Promise<void> => {
    try {
      const outcome = await context.services.interactions.confirm({
        kind: 'confirmation',
        title: 'Continue?',
        message: `Continue with: ${prompt}`,
      }, { signal: turn.controller.signal });
      if (activeTurn !== turn) return;
      emit({ kind: 'message-delta', turnId: turn.turnId, channel: 'assistant', text: `Confirmed: ${outcome.status}. ${prompt}` });
      activeTurn = null;
      emit({ kind: 'turn-complete', turnId: turn.turnId });
    } catch {
      if (activeTurn !== turn) return;
      activeTurn = null;
      emit({
        kind: 'turn-failed',
        turnId: turn.turnId,
        diagnostic: diagnostic('session_agent_interaction_failed', 'The host interaction could not complete.'),
      });
    }
  };

  return {
    runtimeCapabilities: {
      sessionCapabilities: {
        sessionListing: 'unsupported',
        sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
        sessionRollback: { conversation: 'unsupported' },
      },
    },
    async send(request) {
      if (disposed) {
        return {
          status: 'unavailable',
          diagnostic: diagnostic('session_agent_disposed', 'The Session Agent has been disposed.'),
          retryable: false,
        };
      }
      if (request.delivery.kind !== 'newTurn') {
        const unsupported = diagnostic('session_agent_delivery_unsupported', 'This Agent accepts only new-turn delivery.');
        emit({ kind: 'input-rejected', inputIds: request.inputIds, diagnostic: unsupported, retryable: false });
        return { status: 'unsupported', diagnostic: unsupported, retryable: false };
      }
      if (activeTurn) {
        const busy = diagnostic('session_agent_turn_active', 'The Session Agent is already handling a turn.');
        emit({ kind: 'input-rejected', inputIds: request.inputIds, diagnostic: busy, retryable: true });
        return { status: 'rejected', diagnostic: busy, retryable: true };
      }
      if (!providerIdentityPublished) {
        providerIdentityPublished = true;
        emit({ kind: 'provider-session-id', providerSessionId });
      }
      const turn: ActiveTurn = { turnId: request.delivery.turnId, controller: new AbortController() };
      activeTurn = turn;
      emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
      emit({ kind: 'turn-start', turnId: turn.turnId, startedBy: 'host' });
      emit({ kind: 'message-delta', turnId: turn.turnId, channel: 'reasoning', text: 'Preparing the response.' });
      void executeTurn(turn, request.input.text);
      return { status: 'admitted' };
    },
    async cancel(request) {
      if (disposed) {
        return { status: 'unavailable', diagnostic: diagnostic('session_agent_disposed', 'The Session Agent has been disposed.') };
      }
      const turn = activeTurn;
      if (!turn || turn.turnId !== request.turnId) return { status: 'notRunning' };
      turn.controller.abort(request.reason);
      cancelTurn(turn, request.reason);
      return { status: 'requested', turnId: turn.turnId };
    },
    watch(listener) {
      if (!disposed) listeners.add(listener);
      return { dispose() { listeners.delete(listener); } };
    },
    async dispose(reason = 'session_closed') {
      if (disposed) return;
      disposed = true;
      const turn = activeTurn;
      if (turn) {
        turn.controller.abort(reason);
        cancelTurn(turn, disposalCause(reason));
      }
      listeners.clear();
    },
  };
}

/** The activation entry and import-safe Session runner leaf share this stateless factory. */
export const createSessionAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    async open(request, context) {
      const providerSessionId = request.kind === 'resume'
        ? request.providerSessionId
        : `session-agent:${context.session.id}`;
      return createSessionRuntime(context, providerSessionId);
    },
  },
});
