import { describe, expect, it, vi } from 'vitest';
import { fireAndForget } from './fireAndForget';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';

describe('fireAndForget', () => {
    it.each([
        Object.assign(new Error('retired Home'), { name: 'StaleServerGenerationError' }),
        Object.assign(new Error('Home changed'), { name: 'ServerFetchAbortedForServerSwitchError' }),
        new TypeError('Network request failed'),
        Object.assign(new Error('cancelled'), { name: 'AbortError' }),
        new RetryableServerResponseError(503, 'temporarily unavailable'),
        Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' }),
        new WorkflowActionError({ message: 'Account changed', rawCode: 'action_account_scope_changed' }),
    ])('records recoverable background failures without reporting a developer error: $name', async (error) => {
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
        const onError = vi.fn();
        try {
            fireAndForget(Promise.reject(error), { tag: 'test.recoverable', onError });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(report).not.toHaveBeenCalled();
            expect(diagnostic).toHaveBeenCalledWith('[fireAndForget] test.recoverable', error);
            expect(onError).toHaveBeenCalledWith(error);
        } finally {
            report.mockRestore();
            diagnostic.mockRestore();
        }
    });

    it('redacts recoverable failure details when the caller requests tag-only diagnostics', async () => {
        const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const error = new RetryableServerResponseError(503, 'SECRET');
            fireAndForget(Promise.reject(error), { tag: 'test.safe', logError: false });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(diagnostic).toHaveBeenCalledWith('[fireAndForget] test.safe');
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('SECRET');
        } finally { diagnostic.mockRestore(); }
    });
    it('prevents unhandledRejection for a rejected promise', async () => {
        const unhandledSpy = vi.fn();
        process.on('unhandledRejection', unhandledSpy);
        try {
            fireAndForget(Promise.reject(new Error('boom')));
            await new Promise((resolve) => setTimeout(resolve, 0));
        } finally {
            process.removeListener('unhandledRejection', unhandledSpy);
        }
        expect(unhandledSpy).not.toHaveBeenCalled();
    });

    it('invokes the optional onError handler', async () => {
        const onError = vi.fn();
        const error = new Error('boom');
        fireAndForget(Promise.reject(error), { onError });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(onError).toHaveBeenCalledWith(error);
    });

    it('keeps unexpected background failures in diagnostics instead of the development error toast', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const error = new Error('boom');
            const onError = vi.fn();
            fireAndForget(Promise.reject(error), { tag: 'test.tag', onError });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(consoleError).not.toHaveBeenCalled();
            expect(diagnostic).toHaveBeenCalledWith('[fireAndForget] test.tag', error);
            expect(onError).toHaveBeenCalledWith(error);
        } finally {
            consoleError.mockRestore();
            diagnostic.mockRestore();
        }
    });

    it('can log only the tag without dumping the rejected error object', async () => {
        const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const error = Object.assign(new Error('network failed'), {
                config: { headers: { Authorization: 'Bearer SECRET' } },
            });
            fireAndForget(Promise.reject(error), { tag: 'test.safe', logError: false });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(diagnostic).toHaveBeenCalledWith('[fireAndForget] test.safe');
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('SECRET');
        } finally {
            diagnostic.mockRestore();
        }
    });

    it('ignores non-promise inputs', () => {
        expect(() => fireAndForget(undefined as any, { tag: 'test.tag' })).not.toThrow();
        expect(() => fireAndForget(null as any, { tag: 'test.tag' })).not.toThrow();
        expect(() => fireAndForget({} as any, { tag: 'test.tag' })).not.toThrow();
    });
});
