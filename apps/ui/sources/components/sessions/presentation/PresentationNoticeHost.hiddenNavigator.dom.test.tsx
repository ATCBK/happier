/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});

import { PresentationNoticeHost } from './PresentationNoticeHost';
import { publishPresentationNotice, retirePresentationNotice } from './presentationNotices';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps the single notice and its Undo reachable outside the retained hidden navigator on every route', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const undo = vi.fn();
    try {
        for (const route of ['project', 'usage', 'session']) {
            await act(async () => {
                root.render(<div data-testid="navigator" style={{ display: 'none' }}>
                    <div key={route}>{route}</div><PresentationNoticeHost />
                </div>);
                publishPresentationNotice({ key: route, message: 'Reset done', severity: 'info', undo: { label: 'Undo', run: undo } });
            });
            const notices = document.querySelectorAll('[data-testid="current-session-presentation-notice"]');
            expect(notices).toHaveLength(1);
            let ancestor: Element | null = notices[0]!;
            while (ancestor) {
                expect(window.getComputedStyle(ancestor).display).not.toBe('none');
                ancestor = ancestor.parentElement;
            }
            const button = document.querySelector<HTMLElement>('[data-testid="current-session-presentation-notice-undo"]')!;
            await act(async () => button.focus());
            expect(document.activeElement).toBe(button);
            await act(async () => button.click());
        }
        expect(undo).toHaveBeenCalledTimes(3);
    } finally {
        await act(async () => { root.unmount(); retirePresentationNotice(); });
        container.remove();
    }
});

it('enters without fading any ancestor of its glass paint, so its frost samples whatever is beneath (a dialog included)', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    // WAAPI is the browser boundary; the notice, its material and the motion owner stay real.
    const runs: { target: Element; frames: Keyframe[] }[] = [];
    const previousAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement, frames: Keyframe[]) {
        runs.push({ target: this, frames });
        return { playState: 'running', effect: { target: this }, cancel: () => {} } as unknown as Animation;
    } });
    // Hold the browser's clock at the first frame, while the notice is still entering.
    vi.useFakeTimers();
    setReducedMotionPreferenceOverride(false);
    try {
        await act(async () => {
            root.render(<PresentationNoticeHost />);
            publishPresentationNotice({ key: 'frost', message: 'Renamed', severity: 'info', undo: { label: 'Undo', run: () => {} } });
        });
        const notice = document.querySelector<HTMLElement>('[data-testid="current-session-presentation-notice"]')!;
        const paint = notice.querySelector<HTMLElement>('[data-happy-glass-backdrop]')!;
        expect(paint).not.toBeNull();
        // It enters through the browser's material motion: its frame moves by transform, with its paint inside.
        const frameRuns = runs.filter(run => run.target.contains(paint) && run.target !== paint);
        expect(frameRuns.length).toBeGreaterThan(0);
        for (const run of frameRuns) expect(run.frames.some(frame => 'transform' in frame)).toBe(true);
        // Opacity below 1 on an ancestor makes it the paint's backdrop root: the blur would see an empty plane.
        for (let node = paint.parentElement; node && node !== document.body; node = node.parentElement) {
            expect(['', '1']).toContain(node.style.opacity);
            for (const run of runs.filter(candidate => candidate.target === node)) {
                for (const frame of run.frames) expect(frame).not.toHaveProperty('opacity');
            }
        }
    } finally {
        await act(async () => { root.unmount(); retirePresentationNotice(); });
        vi.useRealTimers();
        setReducedMotionPreferenceOverride(null);
        if (previousAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', previousAnimate);
        else delete (HTMLElement.prototype as { animate?: unknown }).animate;
        container.remove();
    }
});
