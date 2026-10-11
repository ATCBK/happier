import type { RawJSONLines } from './rawJsonLines.js';
import { createClaudeTaskNotificationToolResultProjector, readClaudeTaskLifecycleEnvelope } from './taskNotification.js';
import { isClaudeInternalTranscriptMessage } from './visibility.js';

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return `summary: ${message.leafUuid}: ${message.summary}`;
    } else if (message.type === 'system') {
        return message.uuid;
    } else if (message.type === 'progress') {
        const uuid = typeof (message as { uuid?: unknown }).uuid === 'string' ? String((message as { uuid: string }).uuid) : '';
        if (uuid) return `progress:${uuid}`;
        const progressRecord = message as Record<string, unknown>;
        const ts = typeof progressRecord.timestamp === 'string' ? progressRecord.timestamp : '';
        if (ts) return `progress:timestamp:${ts}`;
        return `progress:${JSON.stringify(message)}`;
    } else if (message.type === 'attachment') {
        return `attachment:${message.uuid}`;
    }
    throw Error('Unsupported Claude message type');
}

function isInformationalSystemMessage(message: RawJSONLines): boolean {
    return message.type === 'system';
}

export function createMessageRouter(params: Readonly<{
    onMessage: (message: RawJSONLines) => void;
    logEvent: (event: string, message: RawJSONLines) => void;
}>): Readonly<{
    observeSessionMessage: (message: RawJSONLines) => void;
    emitImportedSidechainMessage: (message: RawJSONLines) => void;
    emitImportedTeamInboxMessage: (message: RawJSONLines) => void;
    emitSessionMessage: (message: RawJSONLines, shouldEmit: boolean) => void;
    reset: () => void;
}> {
    const processedMessageKeys = new Set<string>();
    const taskNotificationProjector = createClaudeTaskNotificationToolResultProjector();
    // Observation and emission may receive the same row separately. Preserve the canonical
    // projector's answer so observing an ACK cannot consume an early completion before emission.
    let observedProjections = new WeakMap<RawJSONLines, RawJSONLines | null>();

    function projectSessionMessage(message: RawJSONLines): RawJSONLines | null {
        if (observedProjections.has(message)) return observedProjections.get(message) ?? null;
        const projected = taskNotificationProjector.project(message);
        const nextMessage = projected ?? (readClaudeTaskLifecycleEnvelope(message)?.subtype === 'task_notification' ? null : message);
        observedProjections.set(message, nextMessage);
        return nextMessage;
    }

    function emitObservedMessage(message: RawJSONLines, eventName: string, shouldEmit: boolean): void {
        const key = messageKey(message);
        if (processedMessageKeys.has(key)) {
            return;
        }
        processedMessageKeys.add(key);

        if (!shouldEmit) {
            return;
        }

        const nextMessage = projectSessionMessage(message);
        if (!nextMessage || isInformationalSystemMessage(nextMessage)) {
            return;
        }
        if (isClaudeInternalTranscriptMessage(nextMessage)) {
            return;
        }

        params.logEvent(eventName, nextMessage);
        params.onMessage(nextMessage);
    }

    function emitImportedMessage(message: RawJSONLines, eventName: string): void {
        const key = messageKey(message);
        if (processedMessageKeys.has(key)) return;
        processedMessageKeys.add(key);
        if (isClaudeInternalTranscriptMessage(message)) return;
        params.logEvent(eventName, message);
        params.onMessage(message);
    }

    return {
        observeSessionMessage: message => { projectSessionMessage(message); },
        emitImportedSidechainMessage: (message: RawJSONLines) => emitImportedMessage(message, 'emit:sidechain-import'),
        emitImportedTeamInboxMessage: (message: RawJSONLines) => emitImportedMessage(message, 'emit:team-inbox'),
        emitSessionMessage: (message: RawJSONLines, shouldEmit: boolean) => emitObservedMessage(message, `emit:${String((message as { type?: unknown })?.type ?? 'unknown')}`, shouldEmit),
        reset: () => {
            processedMessageKeys.clear();
            taskNotificationProjector.clear();
            observedProjections = new WeakMap();
        },
    };
}
