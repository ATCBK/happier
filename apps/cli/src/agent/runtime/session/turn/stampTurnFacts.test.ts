import { describe, expect, it } from 'vitest';
import { stampTurnFacts } from './stampTurnFacts';

describe('stampTurnFacts', () => {
    it('follows the admitted cause rather than the manager tree or destination depth', () => {
        expect(stampTurnFacts({ sessionWorkDepth: 4 })).toEqual({ initiator: 'user', workDepth: 0 });
        expect(stampTurnFacts({ sessionWorkDepth: 4, provenance: { v: 1, kind: 'happierSession', sourceSessionId: 'sender', via: 'mcp', callerDepth: 2 } })).toEqual({ initiator: 'agent_session', workDepth: 3 });
        expect(stampTurnFacts({ sessionWorkDepth: 4, hostContextOnly: true })).toEqual({ initiator: 'host', workDepth: 4 });
        expect(stampTurnFacts({ sessionWorkDepth: 4, hostContextOnly: true, workflowInvocation: { runId: 'workflow', invocationRecordId: 'step' }, workflowWorkDepth: 2 })).toEqual({ initiator: 'workflow', workDepth: 2, workflowInvocation: { runId: 'workflow', invocationRecordId: 'step' } });
    });

    it('does not reinterpret missing host workflow depth or sender depth as a user turn', () => {
        expect(() => stampTurnFacts({ sessionWorkDepth: 0, provenance: { v: 1, kind: 'happierSession', sourceSessionId: 'sender', via: 'mcp' } })).toThrow();
        expect(() => stampTurnFacts({ sessionWorkDepth: 0, workflowInvocation: { runId: 'workflow', invocationRecordId: 'step' } })).toThrow();
    });
});
