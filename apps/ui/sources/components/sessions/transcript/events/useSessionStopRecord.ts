import * as React from 'react';
import { SessionStopRecordV1StoredSchema, type SessionStopRecordV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { buildSessionStopSystemRecordLocalId } from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
import { useSessionSystemRecordBinding, type SessionSystemRecordObservationOptions } from '@/sync/domains/sessionSystemRecords/useSessionSystemRecordBinding';
import { openSessionSystemRecord } from '@/sync/domains/sessionSystemRecords/codec';

type Binding = Readonly<{ status: 'ready'; record: SessionStopRecordV1 | null }>;
const LOADING: Binding = Object.freeze({ status: 'ready', record: null });

export function observeSessionStopRecord(options: SessionSystemRecordObservationOptions<Binding>, at: number): () => void {
        const address = { owner: 'host', namespace: 'activity', kind: 'session_stop.v1',
            localId: buildSessionStopSystemRecordLocalId({ at }) } as const;
        const query = { type: 'read', address } as const;
        let stopped = false;
        let revision = 0;
        const changed = () => {
            const observed = ++revision;
            if (!options.isCurrent() || !options.readCapabilities()?.readTranscript) {
                options.onChange({ status: 'unavailable', reason: 'forbidden' }); return;
            }
            const snapshot = options.repository.getSnapshot(options.session, query);
            if (!snapshot.data) {
                options.onChange(snapshot.lastError ? { status: 'unavailable', reason: snapshot.lastError.status } : LOADING);
                return;
            }
            void openSessionSystemRecord({ record: snapshot.data, address, context: options.readContentContext(),
                decode: value => {
                    const parsed = SessionStopRecordV1StoredSchema.safeParse(value);
                    return parsed.success ? { status: 'ready', value: parsed.data } : { status: 'malformed' };
                },
            }).then(opened => {
                if (stopped || observed !== revision || !options.isCurrent()) return;
                if (!options.readCapabilities()?.readTranscript) {
                    options.onChange({ status: 'unavailable', reason: 'forbidden' }); return;
                }
                options.onChange({ status: 'ready', record: opened.status === 'ready' ? opened.value ?? null : null });
            }).catch(() => {
                if (!stopped && observed === revision) options.onChange({ status: 'unavailable', reason: 'invalid_response' });
            });
        };
        const release = options.repository.subscribe(options.session, query, changed);
        changed();
        return () => { stopped = true; revision++; release(); };
}

/** Mounted only for a stop marker; the incumbent repository owns fetch, invalidation and Home authority. */
export function useSessionStopRecord(input: Readonly<{ serverId: string | null; sessionId: string | null; at: number }>) {
    const observe = React.useCallback((options: SessionSystemRecordObservationOptions<Binding>) =>
        observeSessionStopRecord(options, input.at), [input.at]);
    const binding = useSessionSystemRecordBinding({ serverId: input.serverId, sessionId: input.sessionId ?? '',
        enabled: input.serverId !== null && input.sessionId !== null, loading: LOADING, observe });
    return binding.status === 'ready' ? binding.record : null;
}
