import { describe, expect, it, vi } from 'vitest';

describe('permissionModeOptions i18n descriptions', () => {
    it('builds descriptions from translation keys instead of hardcoded English', async () => {
        vi.resetModules();
        vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => `tx:${key}`,
    });
});

        const { getPermissionModeOptionsForAgentType } = await import('./permissionModeOptions');

        const codex = getPermissionModeOptionsForAgentType('codex');
        const claude = getPermissionModeOptionsForAgentType('claude');

        expect(codex.every((opt) => opt.description.startsWith('tx:'))).toBe(true);
        expect(claude.every((opt) => opt.description.startsWith('tx:'))).toBe(true);
        // The description is its own key, never the option's label key.
        for (const opt of [...codex, ...claude]) {
            expect(opt.description).not.toBe(opt.label);
            expect(opt.description).toMatch(/Description$/);
        }
    });
});
