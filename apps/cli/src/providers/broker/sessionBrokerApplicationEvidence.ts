import type { SessionRuntimeTeamCredentialDenialDetailsV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { SessionBrokerApplicationOutcomeRecorder } from './providerBrokerApplicationFailure';

/** In-memory evidence owned by one host Session lifetime, never Agent state. */
export function createSessionBrokerApplicationEvidence(input: Readonly<{
  readActiveTurnId(): string | null;
  isCurrent(): boolean;
}>) {
  let lastDenial: Readonly<{ turnId: string; denial: SessionRuntimeTeamCredentialDenialDetailsV1 }> | null = null;
  return {
    beginRequest(): SessionBrokerApplicationOutcomeRecorder | undefined {
      const turnId = input.readActiveTurnId();
      if (!turnId || !input.isCurrent()) return undefined;
      return denial => {
        if (!input.isCurrent() || input.readActiveTurnId() !== turnId) return;
        if (denial) lastDenial = { turnId, denial };
        else if (lastDenial?.turnId === turnId) lastDenial = null;
      };
    },
    readDenial(turnId: string): SessionRuntimeTeamCredentialDenialDetailsV1 | null {
      return input.isCurrent() && lastDenial?.turnId === turnId ? lastDenial.denial : null;
    },
  };
}

export type SessionBrokerApplicationEvidence = ReturnType<typeof createSessionBrokerApplicationEvidence>;
