import { describe, expect, it } from 'vitest';
import { CLOSED_SESSION_VIEWER, resolveSessionViewerPresentation, type SessionViewerPresentationState } from './sessionViewerPresentation';

const desktop = { phone: false, canPresentSource: () => true };

describe('Session viewer local presentation', () => {
    it('retains source and pre-expand presentation across source switches, expand, restore and close', () => {
        let state = CLOSED_SESSION_VIEWER;
        const apply = (intent: Parameters<typeof resolveSessionViewerPresentation>[1]) => {
            const outcome = resolveSessionViewerPresentation(state, intent, desktop);
            state = outcome.state;
            return outcome.result;
        };
        expect(apply({ kind: 'viewer.open', source: 'computer' })).toEqual({ status: 'applied' });
        const rect = { x: 20, y: 30, width: 240, height: 180 };
        state = { ...state, rect, width: rect.width, corner: 'tl' };
        expect(apply({ kind: 'viewer.expand' })).toEqual({ status: 'applied' });
        expect(apply({ kind: 'viewer.source.select', source: 'browser' })).toEqual({ status: 'applied' });
        expect(state).toMatchObject({ source: 'browser', mode: 'expanded', restore: { mode: 'floating', rect } });
        expect(apply({ kind: 'viewer.restore' })).toEqual({ status: 'applied' });
        expect(state).toMatchObject({ source: 'browser', mode: 'floating', corner: 'tl', width: 240, rect });
        expect(apply({ kind: 'viewer.close' })).toEqual({ status: 'applied' });
        expect(apply({ kind: 'viewer.restore' })).toEqual({ status: 'unchanged' });
        expect(state).toMatchObject({ source: 'browser', mode: 'closed' });
        expect(apply({ kind: 'viewer.open', source: 'browser' })).toEqual({ status: 'applied' });
        expect(state.mode).toBe('floating');
    });

    it('retains placement independently of phone projection and never admits desktop geometry there', () => {
        const phone = { ...desktop, phone: true };
        const opened = resolveSessionViewerPresentation(CLOSED_SESSION_VIEWER, { kind: 'viewer.open', source: 'browser' }, phone);
        expect(opened.state.mode).toBe('floating');
        const expanded = resolveSessionViewerPresentation(opened.state, { kind: 'viewer.expand' }, phone);
        expect(expanded.state.mode).toBe('expanded');
        expect(resolveSessionViewerPresentation(expanded.state, { kind: 'viewer.restore' }, phone).state.mode).toBe('floating');
        expect(resolveSessionViewerPresentation(opened.state, { kind: 'viewer.corner.set', corner: 'tr' }, phone).result.status).toBe('unavailable');
    });

    it('floats a docked desktop viewer back at its retained placement, never on a phone', () => {
        const rect = { x: 20, y: 30, width: 240, height: 180 };
        const docked: SessionViewerPresentationState = { ...CLOSED_SESSION_VIEWER, source: 'computer', mode: 'docked', rect, width: 240 };
        expect(resolveSessionViewerPresentation(docked, { kind: 'viewer.float' }, desktop)).toEqual({
            state: { ...docked, mode: 'floating' }, result: { status: 'applied' },
        });
        expect(resolveSessionViewerPresentation(docked, { kind: 'viewer.float' }, { ...desktop, phone: true }).result.status).toBe('unavailable');
        const floating = { ...docked, mode: 'floating' as const };
        expect(resolveSessionViewerPresentation(floating, { kind: 'viewer.float' }, desktop).result.status).toBe('unchanged');
        expect(resolveSessionViewerPresentation(CLOSED_SESSION_VIEWER, { kind: 'viewer.float' }, desktop).result.status).toBe('unchanged');
    });

    it('refuses unavailable sources and invalid size without losing the current presentation', () => {
        const state: SessionViewerPresentationState = { ...CLOSED_SESSION_VIEWER, source: 'computer', mode: 'floating' };
        const unavailable = resolveSessionViewerPresentation(state, { kind: 'viewer.source.select', source: 'browser' }, { ...desktop, canPresentSource: source => source === 'computer' });
        expect(unavailable).toEqual({ state, result: { status: 'unavailable' } });
        for (const width of [0, -1, NaN, Infinity]) {
            expect(resolveSessionViewerPresentation(state, { kind: 'viewer.size.set', width }, desktop)).toEqual({ state, result: { status: 'invalidTarget' } });
        }
        const resized = resolveSessionViewerPresentation(state, { kind: 'viewer.size.set', width: 2000 }, desktop);
        expect(resized.state.width).toBe(2000); // Actual measured layout, not an invented maximum, owns clamping.
        expect(resolveSessionViewerPresentation(resized.state, { kind: 'viewer.size.set', width: 2000 }, desktop).result.status).toBe('unchanged');
    });
});
