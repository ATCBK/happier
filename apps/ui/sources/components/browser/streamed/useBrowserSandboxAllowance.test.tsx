import { describe, expect, it } from 'vitest';

import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';

import { describeBrowserSandboxAllowance, useBrowserSandboxAllowance } from './useBrowserSandboxAllowance';

describe('useBrowserSandboxAllowance', () => {
    it('settles with the typed outcome, and returns to idle when the person declined', async () => {
        let outcome: Awaited<ReturnType<NonNullable<Parameters<typeof useBrowserSandboxAllowance>[0]>>> = { status: 'installed' };
        const hook = await renderHook(() => useBrowserSandboxAllowance(async () => outcome));
        expect(hook.getCurrent().allowance).toEqual({ kind: 'idle' });
        await act(async () => { await hook.getCurrent().allow?.(); });
        expect(hook.getCurrent().allowance).toEqual({ kind: 'settled', outcome: { status: 'installed' } });
        outcome = null;
        await act(async () => { await hook.getCurrent().allow?.(); });
        expect(hook.getCurrent().allowance).toEqual({ kind: 'idle' });
        await hook.unmount();
    });

    it('offers no control without an Action to run, and reads a thrown request as a failed one', async () => {
        const none = await renderHook(() => useBrowserSandboxAllowance(undefined));
        expect(none.getCurrent().allow).toBeUndefined();
        await none.unmount();
        const hook = await renderHook(() => useBrowserSandboxAllowance(async () => { throw new Error('offline'); }));
        await act(async () => { await hook.getCurrent().allow?.(); });
        expect(hook.getCurrent().allowance).toEqual({ kind: 'settled', outcome: { status: 'failed', code: 'request_failed' } });
        await hook.unmount();
    });
});

describe('describeBrowserSandboxAllowance', () => {
    it('reads a missing system permission as a warning, any other failure as an error, and success as success', () => {
        expect(describeBrowserSandboxAllowance({ status: 'failed', code: 'os_authorization_required' }).kind).toBe('warning');
        expect(describeBrowserSandboxAllowance({ status: 'failed', code: 'sandbox_install_failed' })).toMatchObject({ kind: 'error', code: 'sandbox_install_failed' });
        expect(describeBrowserSandboxAllowance({ status: 'installed' }, 'Claude').kind).toBe('success');
    });
});
