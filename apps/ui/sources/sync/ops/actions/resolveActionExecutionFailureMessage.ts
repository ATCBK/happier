import { isActionTurnedOffErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { t } from '@/text';
import { getSessionInputFailureLabelKey } from '@/components/sessions/pending/pendingMessageVisualState';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Widget write refusals whose reason and next step the person can act on; any other code keeps the caller's fallback. */
function readWidgetRefusalMessage(code: unknown): string | null {
    switch (code) {
        case 'widget_area_unavailable': return t('widgetAdd.refusals.areaUnavailable');
        case 'widget_area_scope_retired':
        case 'widget_scope_unavailable': return t('widgetAdd.areaScopeRecovery');
        case 'widget_inputs_invalid': return t('widgetAdd.refusals.inputsInvalid');
        case 'widget_type_unavailable': return t('widgetAdd.refusals.typeUnavailable');
        case 'widget_size_unsupported': return t('widgetAdd.refusals.sizeUnsupported');
        case 'widget_edit_denied': return t('widgetAdd.refusals.editDenied');
        default:
            // A write whose acknowledgement never came back (`widget_add_unknown`, `widget_write_ack_unknown`, …) may or may
            // not have landed: say the Home did not confirm it, never that it simply failed.
            return typeof code === 'string' && /^widget_[a-z_]+_unknown$/.test(code) ? t('widgetAdd.refusals.writeUnconfirmed') : null;
    }
}

function readFailureMessage(value: unknown): string | null {
    const record = asRecord(value);
    if (!record) return null;
    const code = record.errorCode ?? record.code;
    if (code === 'credential_scope_denied') return t('errors.permissionDenied');
    if (code === 'server_unreachable' || code === 'home_unreachable') return t('settingsPlugins.targetSelection.unreachableThisHome');
    if (isActionTurnedOffErrorCode(code)) return t('actionConfirmations.turnedOffMessage');
    if (code === 'outcome_unknown' || code === 'approval_execution_outcome_unknown') return t('entityDragDrop.preview.unknownDetail');
    const widgetRefusal = readWidgetRefusalMessage(code);
    if (widgetRefusal) return widgetRefusal;
    const sessionInputLabel = getSessionInputFailureLabelKey({ code });
    if (sessionInputLabel) return t(sessionInputLabel);
    const error = typeof record.error === 'string' ? record.error.trim() : '';
    if (error.length > 0) return error;
    const errorMessage = typeof record.errorMessage === 'string' ? record.errorMessage.trim() : '';
    if (errorMessage.length > 0) return errorMessage;
    return null;
}

/** Thrown adapters retain the same typed failure copy as Action result envelopes. */
export function resolveActionExecutionErrorMessage(error: unknown, fallbackMessage: string): string {
    return readFailureMessage(error) ?? fallbackMessage;
}

function isFailedResult(value: unknown): boolean {
    const record = asRecord(value);
    return record?.ok === false;
}

export function resolveActionExecutionFailureMessage(
    result: unknown,
    fallbackMessage: string,
): string | null {
    const topLevel = asRecord(result);
    if (!topLevel) return fallbackMessage;

    if (topLevel.ok === false) {
        return readFailureMessage(topLevel) ?? fallbackMessage;
    }

    const inner = asRecord(topLevel.result);
    if (!inner) return null;

    if (inner.ok === false) {
        return readFailureMessage(inner) ?? fallbackMessage;
    }

    const results = Array.isArray(inner.results) ? inner.results : [];
    const firstFailed = results.find(isFailedResult);
    if (firstFailed) {
        return readFailureMessage(firstFailed) ?? fallbackMessage;
    }

    return null;
}
