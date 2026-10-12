import { describe, expect, it } from 'vitest';

import { resolveClaudeCodeUsageUserAgent } from './userAgent.js';

describe('resolveClaudeCodeUsageUserAgent', () => {
    it('uses provider-owned Claude Code user agents and ignores generic quota user agents', () => {
        expect(resolveClaudeCodeUsageUserAgent({
            configuredUserAgent: 'generic-happier-agent',
        })).toBe('claude-cli/0.0.0 (external, cli)');
        expect(resolveClaudeCodeUsageUserAgent({
            configuredUserAgent: 'claude-code/1.2.3',
        })).toBe('claude-code/1.2.3');
        expect(resolveClaudeCodeUsageUserAgent({
            configuredUserAgent: 'claude-cli/1.2.3 (external, cli)',
            installedVersion: '9.8.7',
        })).toBe('claude-cli/1.2.3 (external, cli)');
    });

    it('supports a Claude-specific environment override', () => {
        expect(resolveClaudeCodeUsageUserAgent({
            env: {
                HAPPIER_CONNECTED_SERVICES_CLAUDE_CODE_USER_AGENT: 'claude-code/9.8.7',
            },
            configuredUserAgent: 'generic-happier-agent',
        })).toBe('claude-code/9.8.7');
    });

    it('preserves native Claude-specific overrides ahead of version configuration', () => {
        expect(resolveClaudeCodeUsageUserAgent({
            env: {
                HAPPIER_CONNECTED_SERVICES_CLAUDE_CODE_USER_AGENT: '  claude-cli/9.8.7 (external, cli)  ',
                HAPPIER_CLAUDE_CODE_VERSION: '1.2.3',
            },
            configuredUserAgent: 'generic-happier-agent',
        })).toBe('claude-cli/9.8.7 (external, cli)');
    });

    it('uses the actual installed version when no explicit identity is configured', () => {
        expect(resolveClaudeCodeUsageUserAgent({
            installedVersion: ' 2.1.71 ',
        })).toBe('claude-cli/2.1.71 (external, cli)');
    });

    it.each([
        'HAPPIER_CONNECTED_SERVICES_CLAUDE_CODE_VERSION',
        'HAPPIER_CLAUDE_CODE_VERSION',
    ])('formats %s with the native Claude CLI identity', (key) => {
        expect(resolveClaudeCodeUsageUserAgent({
            env: { [key]: ' 2.1.71 ' },
        })).toBe('claude-cli/2.1.71 (external, cli)');
    });
});
