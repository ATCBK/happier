import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { describeManagerRefusal, isManagerRefusal } from '@/components/sessions/work/putUnderPresentation';
import { t } from '@/text';
import { describeSessionListDropReason } from './sessionListDropPresentation';

/** Acknowledged applied/refused or unknown, in the owner's words. */
export function projectActionOutcome(actionId: string, result: ActionExecuteResult): EntityDropOutcomeV1 {
    if (!result.ok) {
        if (actionId === 'session.manager.set' && isManagerRefusal(result.errorCode)) {
            return { status: 'refused', reason: { code: result.errorCode, message: describeManagerRefusal(result.errorCode) } };
        }
        if (result.errorCode === 'credential_scope_denied') {
            return { status: 'refused', reason: { code: result.errorCode, message: t('errors.permissionDenied') } };
        }
        return { status: 'unknown', reason: { code: result.errorCode || 'unknown', message: t('entityDragDrop.preview.unknownDetail') } };
    }
    if (actionId !== 'session.organization.move') return { status: 'applied' };
    const output = result.result as Readonly<{ status?: string; reason?: string }> | null;
    if (output?.status === 'applied') return { status: 'applied' };
    if (output?.status === 'refused' || output?.status === 'unavailable') {
        return { status: 'refused', reason: describeSessionListDropReason(output.reason ?? 'unavailable') };
    }
    return { status: 'unknown', reason: { code: output?.reason ?? 'unknown', message: t('entityDragDrop.preview.unknownDetail') } };
}
