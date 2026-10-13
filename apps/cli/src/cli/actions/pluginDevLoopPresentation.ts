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
    if ('diagnostics' in payload && Array.isArray(payload.diagnostics)) {
      const diagnostic: unknown = payload.diagnostics[0];
      if (diagnostic && typeof diagnostic === 'object' && 'code' in diagnostic && typeof diagnostic.code === 'string') {
        return { errorCode: diagnostic.code,
          ...('message' in diagnostic && typeof diagnostic.message === 'string' ? { errorMessage: diagnostic.message } : {}) };
      }
    }
    return { errorCode: 'plugin_change_failed' };
  },
};
