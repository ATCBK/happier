import { LocalServiceActionRequestV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { readLocalServiceDeclarationName } from '@happier-dev/protocol/actions/specs/localServices';
import type { ApprovalActionReference } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { t } from '@/text';

const CONTROL_ACTION_IDS: ReadonlySet<string> = new Set(['localServices.actions.stopManaged', 'localServices.actions.restartManaged']);

/** A managed Service control acts where that Service runs: its Machine, not the Home that routes the request. */
export function readLocalServiceControlSubject(input: Readonly<{ actionId: string; actionArgs?: unknown }>): ApprovalActionReference | undefined {
    if (!CONTROL_ACTION_IDS.has(input.actionId)) return undefined;
    const request = LocalServiceActionRequestV1Schema.safeParse(input.actionArgs);
    return request.success && request.data.target.kind === 'managed_service'
        ? { kind: 'machine', id: request.data.target.machineId } : undefined;
}

/**
 * Stopping or restarting a managed Service asks about that Service by name, never about the generic Action:
 * the confirmation, Inbox row and approval page all read this one wording, so an Agent's request reads
 * the same as a person's own press.
 */
export function presentLocalServiceControlApproval(input: Readonly<{
    actionId: string;
    actionArgs?: unknown;
    /** The Machine the Service runs on, by name, when the presenting app resolved it. */
    subject?: string | null;
}>): Readonly<{ title: string; summary: string }> | null {
    if (!CONTROL_ACTION_IDS.has(input.actionId)) return null;
    const stop = input.actionId === 'localServices.actions.stopManaged';
    const request = LocalServiceActionRequestV1Schema.safeParse(input.actionArgs);
    if (!request.success || request.data.target.kind !== 'managed_service') return null;
    const service = readLocalServiceDeclarationName(request.data.target.declaration) ?? t('localServices.effectReview.thisService');
    const machine = input.subject?.trim();
    const params = { service, machine: machine ?? '' };
    return stop ? {
        title: t('localServices.effectReview.stopTitle', params),
        summary: machine ? t('localServices.effectReview.stopBodyOn', params) : t('localServices.effectReview.stopBody', params),
    } : {
        title: t('localServices.effectReview.restartTitle', params),
        summary: machine ? t('localServices.effectReview.restartBodyOn', params) : t('localServices.effectReview.restartBody', params),
    };
}
