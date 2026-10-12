import { sync } from '@/sync/sync';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { HappyError } from '@/utils/errors/errors';
import { projectServerScopedSessionSendMessageResult } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { submitSessionUserMessage } from '@/sync/domains/session/input/submitSessionUserMessage';
import type { SessionSubmitPort, SubmitSessionUserMessageOptions, SubmitSessionUserMessageResult } from '@/sync/domains/session/input/types';

import type { SessionTranscriptActions } from './types';

function requireSendSuccess(result: ActionExecuteResult) {
    requireActionSuccess(result);
    if (!result.ok) throw new Error('Unreachable Action refusal');
    const sent = SessionMessageSendResultV1Schema.parse(result.result);
    if (sent.status === 'rejected' || sent.status === 'failed' || sent.status === 'cancelled') {
        throw new HappyError(sent.code, false, { code: sent.code, details: sent });
    }
    return sent;
}

/** Composer and option-chip Send share Action admission; the incumbent submit owner keeps delivery and draft custody. */
export async function submitAppSessionComposerMessage(port: SessionSubmitPort, options: SubmitSessionUserMessageOptions): Promise<SubmitSessionUserMessageResult> {
    let submitted: SubmitSessionUserMessageResult | undefined;
    const execute = createFrontDoorActionExecute(undefined, {
        sessionSendMessage: async ({ permissionModeOverride }) => {
            submitted = await submitSessionUserMessage(port, { ...options,
                metaOverrides: permissionModeOverride
                    ? { ...options.metaOverrides, permissionMode: permissionModeOverride }
                    : options.metaOverrides,
            });
            if (submitted.type === 'send_failed' || submitted.type === 'wake_failed' || submitted.type === 'rejected') {
                throw new HappyError(submitted.errorMessage ?? submitted.type, false, { code: submitted.errorCode ?? submitted.type });
            }
            return projectServerScopedSessionSendMessageResult({ ok: true, ack: {
                localId: submitted.localId,
                accepted: submitted.type === 'success' && submitted.providerAcceptancePending !== true,
            } });
        },
    });
    const execution = await execute('session.message.send', {
        sessionId: options.sessionId, message: options.text,
        ...(typeof options.metaOverrides?.permissionMode === 'string' ? { permissionModeOverride: options.metaOverrides.permissionMode } : {}),
        ...(options.localId ? { localId: options.localId } : {}),
        ...(options.recipient ? { recipient: options.recipient } : {}),
        ...(options.requestedAction ? { requestedAction: options.requestedAction } : {}),
    }, { surface: 'ui', defaultSessionId: options.sessionId, ...(options.serverId ? { serverId: options.serverId } : {}) });
    // An admitted local effect retains the submit owner's failure/custody result.
    // Admission refusals still throw below because no local effect ran.
    if (submitted && (submitted.type === 'send_failed' || submitted.type === 'wake_failed' || submitted.type === 'rejected')) return submitted;
    const sent = requireSendSuccess(execution);
    if (submitted) return submitted;
    // API-token clients receive the canonical remote receipt; their callback
    // clears the exact captured draft just as the local submit owner does.
    if (sent.status === 'outcomeUnknown') return { type: 'rejected', persistence: 'none', errorCode: sent.code,
        errorMessage: sent.code, wake: { attempted: false, state: 'not_needed' } };
    options.onOutboundHandoff?.({ persistence: 'pending', localId: sent.localId });
    return { type: 'success', persistence: 'pending', localId: sent.localId,
        wake: { attempted: false, state: 'not_needed' } };
}

/** The app's Session actions, shared by transcript, Companion and linked plugin approvals. */
export function createAppSessionTranscriptActions(sessionId: string, serverId: string | null): SessionTranscriptActions {
    const execute = createFrontDoorActionExecute();
    const context = { surface: 'ui' as const, defaultSessionId: sessionId, ...(serverId ? { serverId } : {}) };
    return Object.freeze({
        respondToPermission: async (params) => {
            const { id, approved, decision, ...fields } = params;
            requireActionSuccess(await execute('session.permission.respond', {
                ...fields, sessionId, requestId: id, decision: decision ?? (approved ? 'allow' : 'deny'),
            }, context));
        },
        answerUserAction: async (params) => {
            requireActionSuccess(await execute('session.user_action.answer', { sessionId, requestId: params.id,
                answers: Object.entries(params.answers).map(([question, values]) => ({ question, values: [...values] })),
            }, context));
        },
        abort: async () => { requireActionSuccess(await execute('session.turn.cancel', { sessionId }, context)); },
        submitMessage: async (text, options) => {
            // Keep the app submit owner's message-mode, wake and option-chip
            // origin semantics. Its effect runs only after Action admission.
            const submit = createFrontDoorActionExecute(undefined, {
                sessionSendMessage: async ({ sessionId: targetId, message, serverId: targetServerId, permissionModeOverride }) => {
                    const result = await sync.submitMessage(targetId, message, undefined,
                        permissionModeOverride ? { permissionMode: permissionModeOverride } : undefined,
                        { ...options, ...(targetServerId ? { serverId: targetServerId } : {}) });
                    return projectServerScopedSessionSendMessageResult({ ok: true, ack: {
                        localId: result.localId,
                        accepted: result.type === 'success' && result.providerAcceptancePending !== true,
                    } });
                },
            });
            requireSendSuccess(await submit('session.message.send', { sessionId, message: text,
                ...(options?.permissionModeOverride ? { permissionModeOverride: options.permissionModeOverride } : {}),
            }, context));
        },
    } satisfies SessionTranscriptActions);
}
