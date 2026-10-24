import type { SessionRuntimeTeamCredentialDenialDetailsV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { SessionBrokerApplicationOutcomeRecorder } from './providerBrokerApplicationFailure';
import { logger } from '@/ui/logger';

export function recordSessionBrokerApplicationEvidenceRead(input: Readonly<{
  sessionId: string;
  turnId: string;
  pid: number;
  processStartTimeMs?: number;
}> & (Readonly<{ outcome: 'hit' }> | Readonly<{
  outcome: 'miss';
  reason: 'no_evidence' | 'turn_mismatch' | 'pid_mismatch';
}>)): void {
  try {
    logger.infoFile('[provider-broker-application]', {
      stage: 'evidence_read', sessionId: input.sessionId, turnId: input.turnId, pid: input.pid,
      ...(input.processStartTimeMs !== undefined ? { processStartTimeMs: input.processStartTimeMs } : {}),
      outcome: input.outcome, ...(input.outcome === 'miss' ? { reason: input.reason } : {}),
    });
  } catch { /* Diagnostics cannot change the refusal read outcome. */ }
}

/** In-memory evidence owned by one host Session lifetime, never Agent state. */
export function createSessionBrokerApplicationEvidence(input: Readonly<{
  sessionId: string;
  pid: number;
  processStartTimeMs?: number;
  readActiveTurnId(): string | null;
  isCurrent(): boolean;
}>) {
  let lastDenial: Readonly<{ turnId: string; denial: SessionRuntimeTeamCredentialDenialDetailsV1 }> | null = null;
  return {
    beginRequest(): SessionBrokerApplicationOutcomeRecorder {
      const turnId = input.readActiveTurnId();
      const admitted = !!turnId && input.isCurrent();
      const record = (outcome: 'captured' | 'skipped', reason?: 'no_admitted_turn' | 'turn_mismatch' | 'pid_mismatch') => {
        try {
          logger.infoFile('[provider-broker-application]', { stage: 'evidence_capture', sessionId: input.sessionId,
            turnId, pid: input.pid, ...(input.processStartTimeMs !== undefined ? { processStartTimeMs: input.processStartTimeMs } : {}),
            outcome, ...(reason ? { reason } : {}) });
        } catch { /* Diagnostics cannot change refusal custody. */ }
      };
      // Retain an outcome recorder even when no turn was admitted, so only an
      // actual refusal reports the missing attribution; successful probes stay quiet.
      return denial => {
        if (!turnId) { if (denial) record('skipped', 'no_admitted_turn'); return; }
        if (!admitted || !input.isCurrent()) { if (denial) record('skipped', 'pid_mismatch'); return; }
        if (input.readActiveTurnId() !== turnId) { if (denial) record('skipped', 'turn_mismatch'); return; }
        if (denial) { lastDenial = { turnId, denial }; record('captured'); }
        else if (lastDenial?.turnId === turnId) lastDenial = null;
      };
    },
    readDenial(turnId: string): SessionRuntimeTeamCredentialDenialDetailsV1 | null {
      const current = input.isCurrent();
      const denial = current && lastDenial?.turnId === turnId ? lastDenial.denial : null;
      recordSessionBrokerApplicationEvidenceRead({
        sessionId: input.sessionId, turnId, pid: input.pid,
        ...(input.processStartTimeMs !== undefined ? { processStartTimeMs: input.processStartTimeMs } : {}),
        ...(denial ? { outcome: 'hit' } : { outcome: 'miss',
          reason: !current ? 'pid_mismatch' : lastDenial ? 'turn_mismatch' : 'no_evidence' }),
      });
      return denial;
    },
  };
}

export type SessionBrokerApplicationEvidence = ReturnType<typeof createSessionBrokerApplicationEvidence>;
