import type { ActionCliPresentation } from './commandPresentation';

/** Pending daemon reviews and refused changes must never print as completed installs. */
export const PLUGIN_DEV_LOOP_CLI_PRESENTATION: ActionCliPresentation = {
  classifyResult(payload) {
    if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== false) return null;
    if ('pendingReview' in payload && payload.pendingReview && typeof payload.pendingReview === 'object'
      && 'pendingChangeId' in payload.pendingReview && typeof payload.pendingReview.pendingChangeId === 'string') {
      return { errorCode: 'review_required', errorMessage:
        `Install and Trust review is required. Review pending change ${payload.pendingReview.pendingChangeId} in Happier.` };
    }
    const change = 'change' in payload && payload.change && typeof payload.change === 'object'
      ? payload.change as Readonly<Record<string, unknown>>
      : null;
    if (change?.kind === 'registryProfileRequired') {
      return {
        errorCode: 'plugin_registry_profile_required',
        errorMessage: `Npm registry '${String(change.registryOrigin)}' requires a usable registry profile before installing ${String(change.packageName)}.`,
        details: change,
      };
    }
    if (change?.kind === 'failed') {
      return {
        errorCode: 'failed',
        ...('message' in change && typeof change.message === 'string' ? { errorMessage: change.message } : {}),
        details: change,
      };
    }
    if (change?.kind === 'outcomeUnknown') {
      return { errorCode: 'outcome_unknown', details: change };
    }
    if ('diagnostics' in payload && Array.isArray(payload.diagnostics)) {
      const diagnostic: unknown = payload.diagnostics[0];
      if (diagnostic && typeof diagnostic === 'object' && 'code' in diagnostic && typeof diagnostic.code === 'string') {
        return { errorCode: diagnostic.code,
          ...('message' in diagnostic && typeof diagnostic.message === 'string' ? { errorMessage: diagnostic.message } : {}) };
      }
    }
    return { errorCode: 'plugin_change_failed' };
  },
  failureFields(failure) {
    const details = failure.details && typeof failure.details === 'object'
      ? failure.details as Readonly<Record<string, unknown>>
      : null;
    if (failure.errorCode === 'plugin_registry_profile_required' && details) {
      return {
        registryOrigin: details.registryOrigin,
        packageName: details.packageName,
        registryProfileId: details.registryProfileId,
      };
    }
    if (failure.errorCode === 'failed' && details) {
      return {
        causeCode: details.code,
        ...(typeof details.message === 'string' ? { causeMessage: details.message } : {}),
      };
    }
    return null;
  },
};
