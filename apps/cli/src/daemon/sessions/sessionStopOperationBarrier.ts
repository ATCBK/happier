import type { StopSessionResult } from './stopSessionContract';

export type SessionStopOperationBarrier = Readonly<{
  run: (sessionId: string, operation: () => Promise<StopSessionResult>, physicalEffect?: Promise<void>) => Promise<StopSessionResult>;
  registerPhysicalStopEffect: (sessionId: string, completion: Promise<void>) => void;
  wait: (sessionId: string) => Promise<void>;
  has: (sessionId: string) => boolean;
}>;

function normalizeSessionId(sessionId: string): string {
  return String(sessionId ?? '').trim();
}

export function createSessionStopOperationBarrier(): SessionStopOperationBarrier {
  type InFlight = {
    completion: Promise<void>;
    physicalEffects: Set<Promise<void>>;
    stop?: Promise<StopSessionResult>;
  };
  const inFlightBySessionId = new Map<string, InFlight>();
  const refreshCompletion = (sessionId: string, entry: InFlight) => {
    const pending: Promise<unknown>[] = [...entry.physicalEffects, ...(entry.stop ? [entry.stop] : [])];
    const completion = Promise.allSettled(pending).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
    entry.completion = completion;
    const retire = () => {
      if (inFlightBySessionId.get(sessionId) === entry && entry.completion === completion) {
        inFlightBySessionId.delete(sessionId);
      }
    };
    void completion.then(retire, retire);
  };
  const run: SessionStopOperationBarrier['run'] = async (sessionId, operation, physicalEffect) => {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return { status: 'incomplete', reason: 'invalid_session_id' };
    for (;;) {
      const existing = inFlightBySessionId.get(normalizedSessionId);
      if (existing?.stop) return await existing.stop;
      if (existing && (!physicalEffect || !existing.physicalEffects.has(physicalEffect))) {
        await existing.completion;
        continue;
      }
      const entry = existing ?? { completion: Promise.resolve(), physicalEffects: new Set<Promise<void>>() };
      // Publish custody before invoking a producer. Only the exact registered
      // native effect may rejoin its own Stop; other Stops wait for its result.
      const stopping = Promise.resolve().then(operation);
      entry.stop = stopping;
      inFlightBySessionId.set(normalizedSessionId, entry);
      refreshCompletion(normalizedSessionId, entry);
      return await stopping;
    }
  };

  return {
    run,
    registerPhysicalStopEffect: (sessionId, completion) => {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId) return;
      const entry = inFlightBySessionId.get(normalizedSessionId)
        ?? { completion: Promise.resolve(), physicalEffects: new Set<Promise<void>>() };
      if (entry.physicalEffects.has(completion)) return;
      entry.physicalEffects.add(completion);
      inFlightBySessionId.set(normalizedSessionId, entry);
      refreshCompletion(normalizedSessionId, entry);
    },
    wait: async (sessionId) => {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId) return;
      for (;;) {
        const entry = inFlightBySessionId.get(normalizedSessionId);
        if (!entry) return;
        const completion = entry.completion;
        await completion;
        if (entry.completion === completion) return;
      }
    },
    has: (sessionId) => inFlightBySessionId.has(normalizeSessionId(sessionId)),
  };
}
