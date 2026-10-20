import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { installErrorUtilityCommonModuleMocks } from '@/utils/errors/errorUtilityTestHelpers';

installErrorUtilityCommonModuleMocks();
const { resolveToolErrorSummary } = await import('./resolveToolErrorSummary');

describe('resolveToolErrorSummary', () => {
    it.each([
        { success: false, errorCode: 'account_encryption_currentness_unavailable',
            errorMessage: 'account_encryption_currentness_unavailable' },
        { content: JSON.stringify({ errorCode: 'change_title_failed', error: 'account_encryption_currentness_unavailable' }) },
        'Error: account_encryption_currentness_unavailable',
    ])('presents an encryption verification failure as a readable reason in the canonical tool row', (result) => {
        const tool = {
            name: 'change_title', state: 'error', input: { title: 'Explore directory' },
            createdAt: 1, startedAt: 1, completedAt: 2, description: null,
            result,
        } satisfies ToolCall;
        expect(resolveToolErrorSummary(tool)).toBe('settingsAccount.encryptionFactUnread');
    });
    const content = '{"errorCode":"change_title_failed","error":"target_unavailable"}';
    it.each([
        { errorMessage: 'target_unavailable', tool_use_result: `Error: ${content}` },
        // Stored native failure at seq 8 of cmv22orej0085tm3p0v0vi230.
        { content, tool_use_result: `Error: ${content}`, title: 'errorCode' },
    ])('uses the shared typed error instead of a native JSON report', (result) => {
        const tool = {
            name: 'change_title', state: 'error', input: { title: 'Explore directory' },
            createdAt: 1, startedAt: 1, completedAt: 2, description: null, result,
        } satisfies ToolCall;
        expect(resolveToolErrorSummary(tool)).toBe('target_unavailable');
    });
});
