import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';

import { mapLiveStreamPointToContent, type LiveStreamInputGesture } from '@/sync/domains/machines/peer/mediation/stream/inputGesture';

/** A viewer gesture as the browser source's sideband control, normalized to the drawn page. */
export function buildBrowserStreamSidebandControl(input: Readonly<{
    sourceId: string;
    streamId: string;
    eventId: string;
    gesture: LiveStreamInputGesture;
}>): MachineLiveStreamControlSidebandV1 | null {
    const base = { v: 1 as const, streamId: input.streamId, sourceId: input.sourceId, eventId: input.eventId };
    const gesture = input.gesture;
    switch (gesture.kind) {
        case 'tap': {
            const point = mapLiveStreamPointToContent(gesture);
            return point ? { ...base, kind: 'tap', x: point.x, y: point.y } : null;
        }
        case 'swipe': {
            const from = mapLiveStreamPointToContent({ ...gesture, point: gesture.from });
            const to = mapLiveStreamPointToContent({ ...gesture, point: gesture.to });
            if (!from || !to) return null;
            return { ...base, kind: 'swipe', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
        }
        case 'keyboard_text':
            return { ...base, kind: 'keyboard_text', text: gesture.text };
        case 'keyboard_key':
            return { ...base, kind: 'keyboard_key', key: gesture.key };
        default:
            return null;
    }
}
