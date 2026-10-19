import { logger } from '../../../ui/logger';
import { serializeAxiosErrorForLog } from '../../client/serializeAxiosErrorForLog';

import type { ACPProvider } from '../sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from './types';
import type { StreamedTranscriptSegmentRuntime, StreamedTranscriptSegmentState } from './segmentRuntime';
import type { CommittedTranscriptAdmission } from '../transcriptPort';
import {
  buildStreamedTranscriptSegmentSnapshotBody,
  buildStreamedTranscriptSegmentSnapshotMeta,
} from './buildStreamedTranscriptSegmentSnapshot';

export function commitStreamedTranscriptSegmentSnapshot(params: {
  provider: ACPProvider;
  session: StreamedTranscriptWriterSession;
  segment: StreamedTranscriptSegmentRuntime;
  state: StreamedTranscriptSegmentState;
  interruptedReason?: string;
  failureRetryDelayMs?: number;
  onStreamingCommitFailure?: () => void;
  admission?: CommittedTranscriptAdmission;
  runtimeTurnId?: string;
}) {
  const { provider, session, segment, state, interruptedReason } = params;

  if (segment.isCommittingDurable) {
    segment.pendingDurableCommit = { state, interruptedReason };
    return;
  }

  segment.isCommittingDurable = true;

  const nowMs = Date.now();
  const commitVersion = segment.textVersion;
  const commitText = segment.accumulatedText;
  const commitTextLen = commitText.length;
  const durableLocalId = segment.segmentLocalId;
  const body = buildStreamedTranscriptSegmentSnapshotBody(segment);
  const meta = {
    ...buildStreamedTranscriptSegmentSnapshotMeta({ segment, state, interruptedReason, nowMs }),
    ...(params.runtimeTurnId ? { runtimeTurnId: params.runtimeTurnId } : {}),
  };

  const markDurablyPersisted = (delivered: boolean) => {
    segment.didWriteDurable = true;
    segment.lastDurableText = commitText;
    segment.lastCheckpointAtMs = Date.now();
    segment.lastCheckpointTextLen = commitTextLen;
    segment.lastCommittedTextVersion = commitVersion;
    segment.lastCommittedState = state;
    segment.lastCommittedDelivered = delivered;
    segment.appendOnlySinceLastDurableSnapshot = true;
    segment.durableRetryNotBeforeMs = 0;
    const recovered = segment.durableCommitFailure;
    segment.durableCommitFailure = null;
    if (recovered) {
      logger.debug('[StreamedTranscriptWriter] Durable snapshot commit recovered', {
        failureCount: recovered.count,
        suppressedFailureCount: recovered.suppressedCount,
        firstError: recovered.firstError,
        localId: durableLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
      });
    }
  };

  let committedSnapshotPromise: Promise<void>;
  try {
    if (typeof session.enqueueAgentMessageCommitted === 'function') {
      committedSnapshotPromise = session
        .enqueueAgentMessageCommitted(provider, body, {
          localId: durableLocalId,
          meta,
          ...(params.admission ? { admission: params.admission } : {}),
          provenance: {
            kind: 'non_dependent',
            source: segment.sidechainId ? 'sidechain' : 'external',
          },
        })
        .then((result) => {
          if (result.persisted && (!params.admission?.requireDelivery || result.delivered)) markDurablyPersisted(result.delivered);
        });
    } else {
      throw new Error('enqueueAgentMessageCommitted unavailable');
    }
  } catch (error) {
    committedSnapshotPromise = Promise.reject(error);
  }

  let commitFailed = false;
  void committedSnapshotPromise
    .catch((error) => {
      commitFailed = true;
      segment.lastCommitFailedAtMs = Date.now();
      if (state === 'streaming' && params.failureRetryDelayMs !== undefined) {
        segment.durableRetryNotBeforeMs = Date.now() + params.failureRetryDelayMs;
      }
      const serializedError = serializeAxiosErrorForLog(error);
      const failure = segment.durableCommitFailure;
      if (failure) {
        failure.count += 1;
        failure.suppressedCount += 1;
        return;
      }
      segment.durableCommitFailure = {
        firstError: serializedError,
        count: 1,
        suppressedCount: 0,
      };
      logger.debug('[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)', {
        error: serializedError,
        localId: durableLocalId,
        segmentLocalId: segment.segmentLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
        state,
        textLength: commitTextLen,
        textVersion: commitVersion,
        lastCommittedTextVersion: segment.lastCommittedTextVersion,
        lastCommittedState: segment.lastCommittedState,
      });
    })
    .finally(() => {
      segment.isCommittingDurable = false;
      const pendingCommit = segment.pendingDurableCommit;
      segment.pendingDurableCommit = null;
      if (pendingCommit && (!commitFailed || pendingCommit.state !== 'streaming')) {
        commitStreamedTranscriptSegmentSnapshot({
          provider,
          session,
          segment,
          state: pendingCommit.state,
          interruptedReason: pendingCommit.interruptedReason,
          failureRetryDelayMs: params.failureRetryDelayMs,
          onStreamingCommitFailure: params.onStreamingCommitFailure,
          admission: params.admission,
          runtimeTurnId: params.runtimeTurnId,
        });
        return;
      }
      if (commitFailed && state === 'streaming') {
        params.onStreamingCommitFailure?.();
      }
      if (segment.idleWaiters.length === 0) return;
      const waiters = segment.idleWaiters.splice(0, segment.idleWaiters.length);
      for (const waiter of waiters) {
        waiter();
      }
    });
}
