import { describe, expect, it } from 'vitest';

import { buildClaudePredecessorMessageMeta } from './predecessorMessageMeta.js';

describe('buildClaudePredecessorMessageMeta', () => {
    it('carries opt-in Happier attribution to the moving predecessor CLI', () => {
        expect(buildClaudePredecessorMessageMeta({})).toMatchObject({ claudeCodeIncludeInNativeHistory: false });
        expect(buildClaudePredecessorMessageMeta({ claudeCodeIncludeInNativeHistory: true })).toMatchObject({ claudeCodeIncludeInNativeHistory: true });
        expect(buildClaudePredecessorMessageMeta({ claudeCodeIncludeInNativeHistory: 'true' })).toMatchObject({ claudeCodeIncludeInNativeHistory: false });
    });

    it('writes the moving predecessor Claude CLI metadata shape without unrelated current-runtime settings', () => {
        const meta = buildClaudePredecessorMessageMeta({
            claudeCodeExperimentalAgentTeamsEnabled: true,
            claudeRemoteAdvancedOptionsJson: ' { "betas": ["agent-teams"] } ',
            claudeUnifiedTerminalWorkspaceTrust: 'trusted',
        });

        expect(meta.claudeCodeExperimentalAgentTeamsEnabled).toBe(true);
        expect(meta.claudeRemoteAdvancedOptionsJson).toBe('{"betas":["agent-teams"]}');
        expect(meta).not.toHaveProperty('claudeUnifiedTerminalWorkspaceTrust');
    });
});


describe('unified terminal response location metadata', () => {
    it('preserves independent explicit choices and the legacy disabled bridge fallback', () => {
        expect(buildClaudePredecessorMessageMeta({})).toMatchObject({
            claudeUnifiedTerminalQuestionResponseLocation: 'app_and_terminal',
            claudeUnifiedTerminalPermissionResponseLocation: 'app_and_terminal',
        });
        expect(buildClaudePredecessorMessageMeta({
            claudeLocalPermissionBridgeEnabled: false,
            claudeUnifiedTerminalQuestionResponseLocation: 'app_only',
            claudeUnifiedTerminalPermissionResponseLocation: 'invalid',
        })).toMatchObject({
            claudeUnifiedTerminalQuestionResponseLocation: 'app_only',
            claudeUnifiedTerminalPermissionResponseLocation: 'terminal_only',
        });
    });
});
