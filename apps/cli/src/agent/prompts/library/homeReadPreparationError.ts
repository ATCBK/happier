import { PromptStackPreparationError, type PromptStackPreparationReason } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import { classifyServerEndpointError, type ServerEndpointErrorClassification } from '@/api/client/classifyServerEndpointError';
import { logger } from '@/ui/logger';

/** A classified Home read, without the HTTP body, request config or original message. */
export class HomeReadPreparationError extends Error {
  constructor(readonly classification: ServerEndpointErrorClassification) {
    super('Home preparation read failed');
    this.name = 'HomeReadPreparationError';
  }
}

/** Role and prompt preparation share Home transport policy; the runner owns recovery. */
export function classifyHomeReadPreparationError(error: unknown, ref?: PromptArtifactRefV1): unknown {
  if (error instanceof PromptStackPreparationError) return error;
  const classification = classifyServerEndpointError(error);
  const { retryable, statusCode } = classification;
  if (!retryable && !(statusCode !== undefined && statusCode >= 400 && statusCode < 500)) return error;
  // The Artifact owner returns null for a missing document. Its thrown 404 is
  // an unavailable read endpoint, not authority to omit an optional attachment.
  const artifactReadUnavailable = error instanceof Error && 'code' in error && error.code === 'artifact_read_unavailable';
  const reason: PromptStackPreparationReason = retryable ? 'unavailable'
    : statusCode === 401 || statusCode === 403 ? 'locked'
    : statusCode === 404 && !artifactReadUnavailable ? 'not_found' : 'malformed';
  logger.infoFile('[Session] Home preparation read failed', classification);
  // Protocol adds partial admission facts by rebuilding the preparation error.
  // Its existing cause carrier preserves this safe Home fact for startup recovery.
  return Object.assign(new PromptStackPreparationError(reason, ref), { cause: new HomeReadPreparationError(classification) });
}
