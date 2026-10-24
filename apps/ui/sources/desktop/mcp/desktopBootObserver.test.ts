import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('captures document-start failures and boot phases without address disclosure', async () => {
    const source = await readFile(new URL('../../../src-tauri/src/desktop_boot_observer.js', import.meta.url), 'utf8');
    const listeners = new Map<string, (event: { message?: string; reason?: unknown }) => void>();
    const window: {
        addEventListener: (name: string, handler: (event: { message?: string; reason?: unknown }) => void) => void;
        __HAPPIER_DESKTOP_BOOT_OBSERVER__?: {
            documentStart: boolean; readyState: string; phase: string;
            events: { kind: string; value: string }[]; setPhase: (phase: string) => void;
        };
    } = { addEventListener: (name, handler) => { listeners.set(name, handler); } };
    runInNewContext(source, {
        window, document: { readyState: 'loading', addEventListener() {} },
        console: { error() {}, warn() {} }, performance: { now: () => 0 },
    });
    const state = window.__HAPPIER_DESKTOP_BOOT_OBSERVER__!;
    expect(state.documentStart).toBe(true);
    expect(state.readyState).toBe('loading');
    listeners.get('error')!({ message: 'Load failed https://private.example.invalid/app.js' });
    listeners.get('unhandledrejection')!({ reason: 'not recorded raw' });
    state.setPhase('session-drafts');
    expect(state.phase).toBe('session-drafts');
    expect(Array.from(state.events, event => event.kind)).toEqual(['error', 'unhandledrejection', 'phase']);
    expect(state.events[0].value).toBe('Load failed [address omitted]');
    expect(state.events[1].value).toBe('string');
});
