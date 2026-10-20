import { describe, expect, it } from 'vitest';
import { HappierStructuredInputV1Schema } from '@happier-dev/protocol';

import {
  prepareSessionInputForProviderDispatch,
  readStructuredInputPreparationFailure,
  type SessionInputDispatchServices,
} from './prepareSessionInputForProviderDispatch';
import { StructuredInputComposerAttachmentResolutionError } from './resolveStructuredInputProviderContext';

const structuredInput = HappierStructuredInputV1Schema.parse({
  v: 1,
  composerAttachments: [{
    v: 1,
    instanceId: 'issue-1',
    attachment: { pluginId: 'acme.issue-context', localId: 'issue' },
    key: 'issue-42',
    value: { issueId: '42' },
    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
  }],
});

function prepare(services: SessionInputDispatchServices) {
  return prepareSessionInputForProviderDispatch({
    prompt: { text: 'Review this issue', localId: 'input-1', structuredInput },
    transformedUserText: 'Review this issue',
    providerNativeCommand: false,
    signal: new AbortController().signal,
    localId: 'input-1',
    services,
  });
}

describe('Composer attachment dispatch failure classification', () => {
  // Only the daemon turn-contribution RPC is substituted. Projection, envelope
  // validation, failure classification and provider context rendering stay real.
  it('distinguishes an absent dispatch service from a resolver that throws', async () => {
    const absent = await prepare({ sessionId: 'session-1' }).catch(error => error);
    expect(readStructuredInputPreparationFailure(absent)).toMatchObject({
      code: 'composer_attachment_resolution_unavailable', retryable: true,
    });

    const privateCause = 'PRIVATE attachment context /private/fixture';
    const failed = await prepare({
      sessionId: 'session-1',
      resolveComposerAttachmentForDispatch: async () => { throw new Error(privateCause); },
    }).catch(error => error);
    const diagnostic = readStructuredInputPreparationFailure(failed);
    expect(diagnostic).toMatchObject({ code: 'composer_attachment_resolution_failed', retryable: true });
    expect(JSON.stringify(diagnostic)).not.toContain(privateCause);
    expect(failed).not.toHaveProperty('cause');
  });

  it('preserves an already classified refusal and cancellation', async () => {
    const refusal = new StructuredInputComposerAttachmentResolutionError(
      'composer_attachment_resolution_invalid', false, 'Invalid selected attachment',
    );
    const cancellation = new DOMException('Cancelled', 'AbortError');
    for (const error of [refusal, cancellation]) {
      await expect(prepare({
        sessionId: 'session-1',
        resolveComposerAttachmentForDispatch: async () => { throw error; },
      })).rejects.toBe(error);
    }
  });

  it('projects an external declared attachment through the real provider preparation', async () => {
    const prepared = await prepare({
      sessionId: 'session-1',
      resolveComposerAttachmentForDispatch: async input => {
        expect(input).toMatchObject({
          sessionId: 'session-1',
          attachment: { pluginId: 'acme.issue-context', localId: 'issue' },
          request: { sessionId: 'session-1', localId: 'input-1' },
        });
        return { attachments: input.request.attachments.map(attachment => ({
          instanceId: attachment.instanceId, status: 'ready', context: 'Authoritative issue context',
        })) };
      },
    });
    expect(prepared.requiredPrompt).toContain('Authoritative issue context');
    expect(prepared.structuredInput).toMatchObject({ resolvedComposerAttachments: [{
      attachment: { pluginId: 'acme.issue-context', localId: 'issue' }, instanceId: 'issue-1',
    }] });
    expect(prepared.structuredInput).not.toHaveProperty('composerAttachments');
  });
});
