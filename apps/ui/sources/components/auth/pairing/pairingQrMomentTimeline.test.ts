import { describe, expect, it } from 'vitest';
import { FURTHER_PLANET_MOMENT_TIMINGS } from '@happier-dev/brand/planet-moments';
import { advanceQrMoment, qrMomentPanelOf, QR_MOMENT_NONE, selectQrMomentFrame, type QrMomentPanel, type QrMomentScene } from './pairingQrMomentTimeline';

const { QR, SCAN, PAIR } = FURTHER_PLANET_MOMENT_TIMINGS;
const motion = { reducedMotion: false, pairing: true };
const run = (steps: ReadonlyArray<readonly [number, QrMomentPanel]>) =>
    steps.reduce<QrMomentScene>((scene, [ms, panel]) => advanceQrMoment(scene, panel, ms), QR_MOMENT_NONE);

describe('pairing QR moment timeline', () => {
    it('holds still digits while the code is made, assembles on ready and stops at the exact code', () => {
        const making = run([[0, { kind: 'making' }]]);
        expect(selectQrMomentFrame(making, 5_000, motion)).toEqual({ request: { draw: 'making' }, animating: false });
        const ready = advanceQrMoment(making, { kind: 'ready', link: 'a' }, 1_000);
        expect(selectQrMomentFrame(ready, 1_400, motion)).toEqual({ request: { draw: 'qr', link: 'a', t: 0.4 }, animating: true });
        expect(selectQrMomentFrame(ready, 1_000 + QR.T * 1000, motion).animating).toBe(false);
        expect(selectQrMomentFrame(ready, 1_400, { ...motion, reducedMotion: true })).toEqual({ request: { draw: 'qr', link: 'a', t: QR.T }, animating: false });
    });

    it('breaks an expiring code at once and waits exactly as long as the new code takes', () => {
        const scene = run([[0, { kind: 'ready', link: 'a' }], [10_000, { kind: 'making' }], [11_500, { kind: 'ready', link: 'b' }]]);
        expect(scene).toMatchObject({ kind: 'reform', from: 'a', next: 'b', atMs: 10_000, nextAtMs: 11_500 });
        const during = selectQrMomentFrame(scene, 11_600, motion);
        expect(during.request).toEqual({ draw: 'reform', from: 'a', next: 'b', t: 1.6, wait: 1.5 - QR.BREAK });
        expect(selectQrMomentFrame(scene, 10_000 + 1_500 + QR.T * 1000 + 1, motion).animating).toBe(false);
        // While the new code is being made, the broken digits rest: no frames after the break.
        const waiting = run([[0, { kind: 'ready', link: 'a' }], [10_000, { kind: 'making' }]]);
        expect(selectQrMomentFrame(waiting, 10_000 + 5_000, motion)).toEqual({ request: { draw: 'reform', from: 'a', next: null, t: QR.BREAK, wait: null }, animating: false });
    });

    it('folds the held code into the planet on a scan, settles it on the horizon, and traces only on confirmation', () => {
        const adding = run([[0, { kind: 'ready', link: 'a' }], [2_000, { kind: 'adding', device: 'iPhone' }]]);
        expect(selectQrMomentFrame(adding, 2_300, motion)).toEqual({ request: { draw: 'scan', link: 'a', t: 0.3 }, animating: true });
        const scanEnd = 2_000 + SCAN.T * 1000;
        expect(selectQrMomentFrame(adding, scanEnd + 200, motion).request).toEqual({ draw: 'pairing', phase: 'handoff', t: 0.2, device: 'iPhone' });
        // Pending: the settled frame holds; nothing moves until the Home confirms.
        expect(selectQrMomentFrame(adding, scanEnd + 60_000, motion)).toEqual({ request: { draw: 'pairing', phase: 'handoff', t: PAIR.HAND, device: 'iPhone' }, animating: false });
        // A confirmation during the collapse waits for the hand-off to finish before tracing.
        const early = advanceQrMoment(adding, { kind: 'joined', device: 'iPhone' }, 2_100);
        const handoffEnd = scanEnd + PAIR.HAND * 1000;
        expect(selectQrMomentFrame(early, handoffEnd - 10, motion).request).toMatchObject({ phase: 'handoff' });
        expect(selectQrMomentFrame(early, handoffEnd + 400, motion).request).toEqual({ draw: 'pairing', phase: 'joined', t: 0.4, device: 'iPhone' });
        expect(selectQrMomentFrame(early, handoffEnd + PAIR.T * 1000, motion).animating).toBe(false);
    });

    it('rests on the planet when the pairing moment is off, and lands on rest frames under reduced motion', () => {
        const joined = run([[0, { kind: 'ready', link: 'a' }], [2_000, { kind: 'adding', device: 'Studio' }], [2_100, { kind: 'joined', device: 'Studio' }]]);
        expect(selectQrMomentFrame(joined, 9_000, { reducedMotion: false, pairing: false })).toEqual({ request: { draw: 'scan', link: 'a', t: SCAN.T }, animating: false });
        expect(selectQrMomentFrame(joined, 2_150, { reducedMotion: true, pairing: true })).toEqual({ request: { draw: 'pairing', phase: 'joined', t: PAIR.T, device: 'Studio' }, animating: false });
        expect(selectQrMomentFrame(joined, 9_000, { reducedMotion: true, pairing: true }).request).toEqual({ draw: 'pairing', phase: 'joined', t: PAIR.T, device: 'Studio' });
    });

    it('hands every other panel state back to the static block', () => {
        const scene = run([[0, { kind: 'ready', link: 'a' }], [1_000, { kind: 'other' }]]);
        expect(selectQrMomentFrame(scene, 2_000, motion)).toEqual({ request: null, animating: false });
    });

    it('plays each moment only while its switch is on', () => {
        const ready = { kind: 'ready', link: 'a', qrAvailable: true } as const;
        const adding = { kind: 'adding', device: 'iPhone' } as const;
        expect(qrMomentPanelOf(ready, { qr: true, pairing: false })).toEqual({ kind: 'ready', link: 'a' });
        expect(qrMomentPanelOf(ready, { qr: false, pairing: true })).toEqual({ kind: 'other' });
        expect(qrMomentPanelOf({ ...ready, qrAvailable: false }, { qr: true, pairing: true })).toEqual({ kind: 'other' });
        expect(qrMomentPanelOf({ kind: 'making' }, { qr: false, pairing: true })).toEqual({ kind: 'other' });
        expect(qrMomentPanelOf(adding, { qr: false, pairing: true })).toEqual(adding);
        expect(qrMomentPanelOf(adding, { qr: false, pairing: false })).toEqual({ kind: 'other' });
        // Pairing on without the code moment: the scene starts settled on its horizon, with no collapse.
        const scene = advanceQrMoment(QR_MOMENT_NONE, adding, 0);
        expect(selectQrMomentFrame(scene, 10, motion).request).toEqual({ draw: 'pairing', phase: 'handoff', t: PAIR.HAND, device: 'iPhone' });
        expect(selectQrMomentFrame(scene, 10, { ...motion, pairing: false }).request).toBeNull();
    });
});
