import { describe, expect, it } from 'vitest';

import {
  ComposerAttachmentMessageAcceptedV1Schema,
  ComposerAttachmentPrepareRequestV1Schema,
  ComposerAttachmentPrepareResultV1Schema,
  ComposerAttachmentResolveRequestV1Schema,
  ComposerAttachmentResolveRequestV2Schema,
  ComposerAttachmentResolveResultV1Schema,
} from './composerAttachmentRuntimeV1.js';

describe('composer attachment runtime V1', () => {
  it('preserves inline attachment text beyond the former reference-context budget', () => {
    const context = 'Untrusted attachment text\n'.repeat(5_000);
    const result = { attachments: [{ instanceId: 'attachment-1', status: 'ready', context }] };
    expect(ComposerAttachmentResolveResultV1Schema.parse(result)).toEqual(result);
  });

  it('keeps V1 Session identity unchanged and admits host-stamped Session or execution-run V2 scope', () => {
    const attachments = [{ instanceId: 'attachment-1', key: 'issue', value: { issueId: '42' } }];

    expect(ComposerAttachmentResolveRequestV2Schema.parse({
      scope: { kind: 'session', sessionId: 'session-1' },
      localId: 'local-1',
      attachments,
    }).scope).toEqual({ kind: 'session', sessionId: 'session-1' });
    expect(ComposerAttachmentResolveRequestV2Schema.parse({
      scope: { kind: 'execution_run', executionRunId: 'run-1' },
      localId: 'local-1',
      attachments,
    }).scope).toEqual({ kind: 'execution_run', executionRunId: 'run-1' });
    expect(ComposerAttachmentResolveRequestV2Schema.safeParse({
      sessionId: 'run-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(false);
  });

  it('uses sessionId and localId as the sole attachment-runtime identity', () => {
    const attachments = [{
      instanceId: 'attachment-1',
      key: 'issue',
      value: { issueId: '42', summary: 'Ready' },
    }];

    expect(ComposerAttachmentResolveRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(true);
    expect(ComposerAttachmentResolveRequestV1Schema.safeParse({
      sessionId: 'session-1',
      messageId: 'message-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(false);
    expect(ComposerAttachmentResolveRequestV1Schema.safeParse({
      sessionId: 'session-1',
      messageLocalId: 'local-1',
      attachments,
    }).success).toBe(false);

    expect(ComposerAttachmentPrepareRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(true);
    expect(ComposerAttachmentPrepareRequestV1Schema.safeParse({
      sessionId: 'session-1',
      messageLocalId: 'local-1',
      attachments,
    }).success).toBe(false);

    expect(ComposerAttachmentMessageAcceptedV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(true);
    expect(ComposerAttachmentMessageAcceptedV1Schema.safeParse({
      sessionId: 'session-1',
      messageId: 'message-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(false);
    expect(ComposerAttachmentMessageAcceptedV1Schema.safeParse({
      sessionId: 'session-1',
      messageLocalId: 'local-1',
      attachments,
    }).success).toBe(false);
  });

  it('keeps each lifecycle payload closed and permits only opaque staged media during preparation', () => {
    expect(ComposerAttachmentPrepareRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42' },
      }],
    }).success).toBe(true);

    const stagedContent = {
      kind: 'stagedMedia',
      handle: {
        v: 1,
        id: 'stage-1',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        owner: { pluginId: 'acme.media', localId: 'image' },
        mediaKind: 'image',
        mimeType: 'image/png',
        name: 'hero.png',
        sizeBytes: 42,
        sha256: 'a'.repeat(64),
      },
    } as const;

    expect(ComposerAttachmentPrepareRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42' },
        content: stagedContent,
      }],
    }).success).toBe(true);

    expect(ComposerAttachmentPrepareResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'ready',
        value: { issueId: '42', summary: 'Ready' },
        content: stagedContent,
      }],
    }).success).toBe(true);
    expect(ComposerAttachmentPrepareResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'ready',
        value: { issueId: '42', summary: 'Ready' },
        mediaIds: ['media-1'],
      }],
    }).success).toBe(false);
    expect(ComposerAttachmentPrepareResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'ready',
        value: { issueId: '42', summary: 'Ready' },
        media: [{ id: 'media-1' }],
      }],
    }).success).toBe(false);
    expect(ComposerAttachmentPrepareResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'failed',
        retryable: true,
        unexpected: true,
      }],
    }).success).toBe(false);

    expect(ComposerAttachmentResolveRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42', summary: 'Ready' },
      }],
    }).success).toBe(true);
    expect(ComposerAttachmentResolveRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42', summary: 'Ready' },
        mediaIds: ['media-1'],
      }],
    }).success).toBe(false);

    expect(ComposerAttachmentResolveResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'ready',
        context: 'Issue 42 is open.',
        data: { severity: 'high' },
      }],
    }).success).toBe(true);
    expect(ComposerAttachmentResolveResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'ready',
        mediaIds: ['media-1'],
      }],
    }).success).toBe(false);

    expect(ComposerAttachmentMessageAcceptedV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42', summary: 'Ready' },
      }],
    }).success).toBe(true);
    expect(ComposerAttachmentMessageAcceptedV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42', summary: 'Ready' },
        mediaIds: ['media-1'],
      }],
    }).success).toBe(false);
  });

  it('accepts only the approved r1.0 non-ready outcomes', () => {
    expect(ComposerAttachmentResolveResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'cancelled',
        retryable: true,
      }],
    }).success).toBe(false);
    expect(ComposerAttachmentResolveResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'unsupported',
        retryable: true,
      }],
    }).success).toBe(false);
  });
});
