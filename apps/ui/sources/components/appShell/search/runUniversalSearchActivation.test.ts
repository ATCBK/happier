import { describe, expect, it, vi } from 'vitest';

import { runUniversalSearchActivation } from './runUniversalSearchActivation';

describe('runUniversalSearchActivation', () => {
    it.each([null, false] as const)('distinguishes a cancelled open (%s) from a refused open after dismissal', async outcome => {
        const order: string[] = [];
        await runUniversalSearchActivation({
            dismiss: () => { order.push('dismiss'); },
            activate: async () => { order.push('activate'); return outcome; },
            presentFailure: () => { order.push('failure'); },
        });
        expect(order).toEqual(outcome === null ? ['dismiss', 'activate'] : ['dismiss', 'activate', 'failure']);
    });

    it('abandons a selected file when query, workspace or close supersedes async preparation', async () => {
        let current = true;
        const activate = vi.fn(async () => true);
        const dismiss = vi.fn();
        const presentFailure = vi.fn();
        await runUniversalSearchActivation({ isCurrent: () => current,
            prepare: async () => { current = false; return true; }, activate, dismiss, presentFailure });
        expect(activate).not.toHaveBeenCalled();
        expect(dismiss).not.toHaveBeenCalled();
        expect(presentFailure).not.toHaveBeenCalled();
    });
    it('keeps Search open when the selected identity is no longer current', async () => {
        const order: string[] = [];
        const activate = vi.fn(async () => true);

        await runUniversalSearchActivation({
            prepare: () => {
                order.push('prepare');
                return false;
            },
            dismiss: () => { order.push('dismiss'); },
            activate,
            presentFailure: () => { order.push('failure'); },
        });

        expect(order).toEqual(['prepare', 'failure']);
        expect(activate).not.toHaveBeenCalled();
    });

    it('dismisses before activation settles and awaits its exact owner', async () => {
        const order: string[] = [];
        let settle!: (value: boolean) => void;
        const pending = new Promise<boolean>((resolve) => { settle = resolve; });
        const run = runUniversalSearchActivation({
            prepare: () => { order.push('prepare'); return true; },
            dismiss: () => { order.push('dismiss'); },
            activate: async () => {
                order.push('activate');
                const result = await pending;
                order.push('settled');
                return result;
            },
            presentFailure: vi.fn(),
        });
        await Promise.resolve();
        expect(order).toEqual(['prepare', 'dismiss', 'activate']);
        settle(true);
        await run;
        expect(order).toEqual(['prepare', 'dismiss', 'activate', 'settled']);
    });

    it('catches a rejected activation after dismissal and presents failure once', async () => {
        const order: string[] = [];
        const presentFailure = vi.fn(() => { order.push('failure'); });
        await runUniversalSearchActivation({
            dismiss: () => { order.push('dismiss'); },
            activate: async () => {
                order.push('activate');
                throw new Error('gone');
            },
            presentFailure,
        });
        expect(order).toEqual(['dismiss', 'activate', 'failure']);
        expect(presentFailure).toHaveBeenCalledOnce();
    });
});
