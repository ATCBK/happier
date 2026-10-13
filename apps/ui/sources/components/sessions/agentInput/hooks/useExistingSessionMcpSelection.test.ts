import { describe, expect, it } from 'vitest';

import {
    shouldShowExistingSessionMcpChip,
} from './useExistingSessionMcpSelection';

describe('shouldShowExistingSessionMcpChip', () => {
    it('allows MCP selection only for writable inactive sessions with an agent', () => {
        expect(shouldShowExistingSessionMcpChip({ isReadOnly: false, sessionActive: false, agentAvailable: true })).toBe(true);
        expect(shouldShowExistingSessionMcpChip({ isReadOnly: true, sessionActive: false, agentAvailable: true })).toBe(false);
        expect(shouldShowExistingSessionMcpChip({ isReadOnly: false, sessionActive: true, agentAvailable: true })).toBe(true);
        expect(shouldShowExistingSessionMcpChip({ isReadOnly: false, sessionActive: false, agentAvailable: false })).toBe(false);
    });

});
