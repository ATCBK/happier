import { expect, it, vi } from 'vitest';

// Compile the real cold-import graphs during collection. The behavior below
// still resets module state; Vite transformation is not an initialization deadline.
await import('./rawCredentialClient');
await import('../runtime/bundledSpeech/bundledSpeechRuntime');

it.each([
    ['raw credential client', () => import('./rawCredentialClient'), 'createVoiceClientRawCredentialAccess'],
    ['speech runtime', () => import('../runtime/bundledSpeech/bundledSpeechRuntime'), 'createBundledSpeechRuntime'],
] as const)('loads the %s before its default Voice dependencies finish initializing', async (_label, load, exportName) => {
    // Keep the real sync/Voice import graph: speech client singleton creation
    // must not read the execution-machine resolver during module evaluation.
    vi.resetModules();
    await expect(load()).resolves.toHaveProperty(exportName);
});
