import { createHash } from 'node:crypto';

/** Existing approved Artifact custody owns omitted retry keys, not each transport attempt. */
export function deriveApprovedDiscussionMutationLocalId(params: Readonly<{
  artifactId: string;
  purpose: 'creation' | 'first_message' | 'post';
}>): string {
  return `approved-discussion-v1:${createHash('sha256').update(JSON.stringify([
    'happier.discussion-approved-mutation.v1', params.artifactId, params.purpose,
  ])).digest('base64url')}`;
}
