import { readSessionStopTranscriptRecordV1, type SessionStopRecordV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { formatMachineDuration } from '@/components/machines/durationWords';
import { t } from '@/text';

/**
 * One quiet line for the Guard intent and its current settlement (plan 50 GRD-23, lab `rg` G3-6).
 * Only observed stopped facts show why, when and what was freed. Null for an unrelated or
 * unrecognised message, which then renders as ordinary stored text.
 */
export function describeSessionStopMarker(event: unknown, formatTime: (at: number) => string, current?: SessionStopRecordV1 | null): Readonly<{ text: string; at: number; status: SessionStopRecordV1['status'] }> | null {
    const requested = readSessionStopTranscriptRecordV1(event);
    if (!requested) return null;
    const record = current?.at === requested.at && current.rule === requested.rule ? current : requested;
    const time = formatTime(record.settledAt ?? record.at);
    if (record.status !== 'stopped') {
        const key = record.status === 'cancelled' ? 'machineGuard.session.markerCancelled'
            : record.status === 'failed' ? 'machineGuard.session.markerFailed' : 'machineGuard.session.markerRequested';
        return { text: t(key, { time }), at: record.at, status: record.status };
    }
    const lead = record.rule === 'idle_sessions' && record.idleMs !== undefined
        ? t('machineGuard.session.markerIdle', { duration: formatMachineDuration(record.idleMs), time })
        : record.rule === 'ceiling' ? t('machineGuard.session.markerCeiling', { time })
            : t('machineGuard.session.markerMemory', { time });
    const text = record.freedBytes !== undefined && record.freedBytes > 0
        ? `${lead} · ${t('machineGuard.session.markerFreed', { amount: formatHappierDataBytes(record.freedBytes, { kind: 'memory' }) })}`
        : lead;
    return { text, at: record.at, status: record.status };
}
