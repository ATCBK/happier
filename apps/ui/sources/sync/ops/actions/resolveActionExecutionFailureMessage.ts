import { t } from '@/text';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readFailureMessage(value: unknown): string | null {
    const record = asRecord(value);
    if (!record) return null;
    const code = record.errorCode ?? record.code;
    if (code === 'server_unreachable' || code === 'home_unreachable') return t('settingsPlugins.targetSelection.unreachableThisHome');
    if (code === 'outcome_unknown' || code === 'approval_execution_outcome_unknown') return t('entityDragDrop.preview.unknownDetail');
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
