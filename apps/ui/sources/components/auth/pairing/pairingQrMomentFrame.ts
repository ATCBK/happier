import { pairingMomentFrame, planetCollapseCells, qrMomentFrame, qrMomentModel, type MomentPaintCommand, type PlanetCollapseCell, type QrMomentModel } from '@happier-dev/brand/planet-moments';
import { createQRMatrix } from '@/components/qr/qrMatrix';
import { isPairingQrMarked } from './pairingQrMark';
import type { QrMomentFrameRequest } from './pairingQrMomentTimeline';
import type { PairingQrMomentCanvasProps } from './pairingQrMoment.types';

const MAKING_STAND_IN = `happier:///pair?v=2&payload=${'e'.repeat(562)}`;

/** A mounted panel owns only its current and replacement models; both platform painters consume this owner. */
export function createPairingQrMomentFrames() {
    const models = new Map<string, QrMomentModel>();
    const targets = new WeakMap<QrMomentModel, Partial<Record<'light' | 'dark', readonly PlanetCollapseCell[]>>>();
    const modelOf = (link: string, size: number, dpr: number) => {
        const key = `${size}|${dpr}|${link}`;
        let model = models.get(key);
        if (!model) {
            const matrix = createQRMatrix(link, isPairingQrMarked(link) ? 'quartile' : 'medium');
            model = qrMomentModel({ size: matrix.size, data: matrix.bits, text: link }, size, dpr);
            models.set(key, model);
        }
        return model;
    };
    return (request: QrMomentFrameRequest, props: PairingQrMomentCanvasProps, dpr: number): readonly MomentPaintCommand[] => {
        const { size, theme } = props;
        // Drop superseded payloads on lifecycle changes; no fixed cache ceiling or app-wide payload retention.
        const links = request.draw === 'making' ? [MAKING_STAND_IN] : request.draw === 'pairing' ? [] : request.draw === 'reform' ? [request.from, request.next] : [request.link];
        for (const [key, model] of models) if (!links.includes(model.text) || !key.startsWith(`${size}|${dpr}|`)) models.delete(key);
        switch (request.draw) {
            case 'making': return qrMomentFrame(modelOf(MAKING_STAND_IN, size, dpr), -1, { size, theme }).commands;
            case 'qr': return qrMomentFrame(modelOf(request.link, size, dpr), request.t, { size, theme }).commands;
            case 'reform': {
                const from = modelOf(request.from, size, dpr);
                return qrMomentFrame(from, request.t, { size, theme, phase: 'reform', next: request.next === null ? from : modelOf(request.next, size, dpr), wait: request.wait ?? Number.POSITIVE_INFINITY }).commands;
            }
            case 'scan': {
                const model = modelOf(request.link, size, dpr);
                const byTheme = targets.get(model) ?? {}; targets.set(model, byTheme);
                const collapseTargets = byTheme[theme] ??= planetCollapseCells({ R: size * 0.29, theme });
                return qrMomentFrame(model, request.t, { size, theme, phase: 'scan', collapseTargets }).commands;
            }
            case 'pairing': return pairingMomentFrame(request.t, { w: size, h: size, theme, layout: 'square', phase: request.phase,
                devices: [...props.machines.filter(name => name !== request.device).slice(0, 2).map(n => ({ n })), { n: request.device, isNew: true }] });
        }
    };
}
