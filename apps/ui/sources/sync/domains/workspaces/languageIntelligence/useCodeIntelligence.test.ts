import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useCodeIntelligence } from './useCodeIntelligence';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';

describe('retained File-page code intelligence holder', () => {
    it('consumes the same P4 holder when its text editor has no code-decoration or cursor capabilities', async () => {
        const editor: TextEditorHandle = { getValue: () => '# Heading', flushPendingChange: async () => {} };
        const scope = { serverId: 'holder-home', machineId: 'machine', rootPath: '/repo' };
        const liveValue = { get: () => '# Heading' };
        const accountLifetime: ServerAccountScopeLifetime = {
            scope: { serverId: 'holder-home', accountId: 'holder-account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }),
        };
        const hook = await renderHook(() => useCodeIntelligence({ scope, path: 'a.md', languageId: 'markdown', active: true,
            liveValue, editorHandleRef: { current: editor }, accountLifetime, openLocation() {} }));
        try { expect(hook.getCurrent().controller).not.toBeNull(); }
        finally { await hook.unmount(); }
    });
    it('keeps controller and subscriptions when command focus leaves and releases them on unmount', async () => {
        const accountListeners = new Set<() => void>();
        const textListeners = new Set<() => void>();
        const accountLifetime: ServerAccountScopeLifetime = {
            scope: { serverId: 'holder-home', accountId: 'holder-account' }, isCurrent: () => true,
            onRetire: (listener) => {
                accountListeners.add(listener);
                return { dispose: () => { accountListeners.delete(listener); } };
            },
        };
        const liveValue = { get: () => 'const value = 1;', subscribe: (listener: () => void) => {
            textListeners.add(listener);
            return () => { textListeners.delete(listener); };
        } };
        const scope = { serverId: 'holder-home', machineId: 'machine', rootPath: '/repo' };
        const openLocation = () => {};
        const hook = await renderHook(({ active }) => useCodeIntelligence({ scope, path: 'a.ts', languageId: 'typescript',
            active, liveValue, accountLifetime, openLocation }), { initialProps: { active: true } });
        try {
            const first = hook.getCurrent().controller;
            expect(first).not.toBeNull();
            expect(accountListeners.size).toBe(1);
            expect(textListeners.size).toBe(1);
            await hook.rerender({ active: false });
            expect(hook.getCurrent().controller).toBe(first);
            expect(accountListeners.size).toBe(1);
            expect(textListeners.size).toBe(1);
        } finally { await hook.unmount(); }
        expect(accountListeners.size).toBe(0);
        expect(textListeners.size).toBe(0);
    });
});
