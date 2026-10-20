import { expect, it, vi } from 'vitest';

it('resolves a three-module cycle entered concurrently through two modules', async () => {
    const [a, b] = await Promise.all([
        import('./testkit/fixtures/vitestAsyncMockContext/concurrentA'),
        import('./testkit/fixtures/vitestAsyncMockContext/concurrentB'),
    ]);
    expect([a.concurrentA, b.concurrentB]).toEqual(['a', 'b']);
});

it('waits for a shared asynchronous dependency when no cycle exists', async () => {
    const [a, b] = await Promise.all([
        import('./testkit/fixtures/vitestAsyncMockContext/sharedConsumerA'),
        import('./testkit/fixtures/vitestAsyncMockContext/sharedConsumerB'),
    ]);
    expect([a.readyA, b.readyB]).toEqual([true, true]);
});

// Guards the pinned Vitest patch with a real import cycle. Two-module cycles
// also hit Vite's reciprocal-edge shortcut and would hide the lost ancestry.
vi.mock('./testkit/fixtures/vitestAsyncMockContext/nested', () => ({ value: 'nested mock' }));
vi.mock('./testkit/fixtures/vitestAsyncMockContext/entry', async (importOriginal) => {
    await import('./testkit/fixtures/vitestAsyncMockContext/nested');
    return importOriginal();
});

it('retains the original import ancestry after a nested asynchronous mock', async () => {
    const { readValue } = await import('./testkit/fixtures/vitestAsyncMockContext/consumer');
    expect(readValue()).toBe('original');
});

it('retains the original import ancestry for dynamically registered mocks', async () => {
    vi.resetModules();
    vi.doMock('./testkit/fixtures/vitestAsyncMockContext/nested', () => ({ value: 'new nested mock' }));
    vi.doMock('./testkit/fixtures/vitestAsyncMockContext/entry', async (importOriginal) => {
        await import('./testkit/fixtures/vitestAsyncMockContext/nested');
        return importOriginal();
    });
    const { readValue } = await import('./testkit/fixtures/vitestAsyncMockContext/consumer');
    expect(readValue()).toBe('original');
});
