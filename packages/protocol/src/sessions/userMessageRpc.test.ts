import { describe, expect, it } from 'vitest';
import { PUBLIC_ACTION_INPUT_SCHEMAS } from '../actions/actionSpecs.js';

import {
  SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema,
  SessionPendingMessageComposerAdmissionPrepareRequestV1Schema,
  SessionPendingMessageComposerAdmissionPrepareResponseV1Schema,
  SessionPendingMessageComposerAdmissionAbandonedRequestV1Schema,
  readAttachmentEnvelopeLocalImagePaths,
  sanitizeSessionUserMessageSendMeta,
  SessionUserMessageSendRequestSchema,
  SessionUserMessageSendResponseSchema,
} from './userMessageRpc.js';

const pluginAttachment = {
  v: 1,
  instanceId: 'attachment-1',
  attachment: {
    pluginId: 'com.acme.review',
    localId: 'review',
  },
  key: 'review-42',
  value: { reviewId: '42' },
  presentation: { label: 'Review #42', typeLabel: 'Review comment', icon: 'info' },
} as const;

const stagedMediaHandle = {
  v: 1,
  id: 'stage-1',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  owner: { pluginId: 'acme.media', localId: 'image' },
  mediaKind: 'image',
  mimeType: 'image/png',
  name: 'hero.png',
  sizeBytes: 42,
  sha256: 'a'.repeat(64),
} as const;

const stagedImageAttachment = {
  v: 1,
  instanceId: 'attachment-media-1',
  attachment: { pluginId: 'acme.media', localId: 'image' },
  key: 'hero-image',
  value: { alt: 'A mountain lake' },
  presentation: { label: 'Hero image', typeLabel: 'Image' },
  content: { kind: 'stagedMedia', handle: stagedMediaHandle },
} as const;

const stagedVideoAttachment = {
  ...stagedImageAttachment,
  instanceId: 'attachment-media-2',
  key: 'hero-clip',
  content: {
    kind: 'stagedMedia',
    handle: { ...stagedMediaHandle, id: 'stage-2', mediaKind: 'video', mimeType: 'video/webm', name: 'hero.webm' },
  },
} as const;

describe('SessionUserMessageSendResponseSchema', () => {
  it('accepts successful ACK payloads', () => {
    expect(SessionUserMessageSendResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it('accepts runtime error ACK payloads', () => {
    expect(
      SessionUserMessageSendResponseSchema.parse({
        ok: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      }),
    ).toEqual({
      ok: false,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    });
  });
});

describe('SessionUserMessageSendRequestSchema', () => {
  it('retains issued handles through attachment-only public Action and Session RPC admission', () => {
    const handle = { v: 1, sessionId: 'target-session', id: 'upload-1' };
    const structuredInput = { v: 1, sessionAttachments: [handle] };
    const action = PUBLIC_ACTION_INPUT_SCHEMAS['session.message.send'].parse({
      sessionId: 'target-session', message: '', structuredInput,
    });
    const request = SessionUserMessageSendRequestSchema.parse({ text: action.message,
      meta: { happierStructuredInputV1: action.structuredInput },
    });
    expect(request.meta.happierStructuredInputV1).toEqual(structuredInput);
    expect(sanitizeSessionUserMessageSendMeta({ happierStructuredInputV1: structuredInput }))
      .toEqual({ happierStructuredInputV1: structuredInput });
    for (const sessionAttachments of [[], [{ ...handle, path: '/etc/passwd' }], null]) {
      expect(SessionUserMessageSendRequestSchema.safeParse({ text: '',
        meta: { happierStructuredInputV1: { v: 1, sessionAttachments } },
      }).success).toBe(false);
    }
  });

  it('retains typed source review context until admission alongside staged media', () => {
    const reviewComments = { sessionId: 'source-session', comments: [{
      id: 'comment-1', filePath: 'src/index.ts', source: 'file',
      anchor: { kind: 'line', filePath: 'src/index.ts', line: 2 },
      snapshot: { selectedLines: ['const value = 1;'], beforeContext: [], afterContext: [] },
      body: 'Keep this exact context', createdAt: 1,
    }] };
    const request = SessionUserMessageSendRequestSchema.parse({ text: 'Review this', meta: {
      happierStructuredInputV1: { v: 1, reviewComments, composerAttachments: [stagedImageAttachment] },
    } });
    expect(request.meta).toEqual({ happierStructuredInputV1: {
      v: 1, reviewComments, composerAttachments: [stagedImageAttachment],
    } });
  });

  it('permits attachment-only sends only after canonical structured-input admission', () => {
    const attachmentOnly = SessionUserMessageSendRequestSchema.safeParse({
      text: '',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [pluginAttachment],
        },
      },
    });

    expect(attachmentOnly.success).toBe(true);
    expect(attachmentOnly.success && attachmentOnly.data.meta).toMatchObject({
      happierStructuredInputV1: { composerAttachments: [pluginAttachment] },
    });
    expect(SessionUserMessageSendRequestSchema.safeParse({
      text: '',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{ malformed: true }],
        },
      },
    }).success).toBe(false);
    expect(SessionUserMessageSendRequestSchema.safeParse({
      text: '',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          mentions: [{
            kind: 'happier.file',
            ref: 'file:src/index.ts',
            token: '@src/index.ts',
            start: 0,
            end: 13,
          }],
        },
      },
    }).success).toBe(false);
    expect(SessionUserMessageSendRequestSchema.safeParse({ text: '', meta: {} }).success).toBe(false);
  });

  it('admits an attachment-only send whose staged media the daemon finalizer has not yet replaced', () => {
    for (const attachment of [stagedImageAttachment, stagedVideoAttachment]) {
      const parsed = SessionUserMessageSendRequestSchema.safeParse({
        text: '',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            composerAttachments: [attachment],
          },
        },
      });

      expect(parsed.success).toBe(true);
      // The raw ingress arm reaches the daemon finalizer intact; sanitizing it
      // through the persisted envelope here would delete the staged claim.
      expect(parsed.success && parsed.data.meta).toEqual({
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [attachment],
        },
      });
    }
  });

  it('rejects an attachment-only send whose staged media claim is not a readable ingress handle', () => {
    for (const brokenHandle of [
      { ...stagedMediaHandle, mimeType: 'application/pdf' },
      { ...stagedMediaHandle, mediaKind: 'video' },
      { ...stagedMediaHandle, sha256: 'nope' },
      { ...stagedMediaHandle, path: '/tmp/hero.png' },
    ]) {
      const parsed = SessionUserMessageSendRequestSchema.safeParse({
        text: '',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            composerAttachments: [{ ...stagedImageAttachment, content: { kind: 'stagedMedia', handle: brokenHandle } }],
          },
        },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('keeps a contentful send with staged media intact instead of stripping the attachment', () => {
    const parsed = SessionUserMessageSendRequestSchema.safeParse({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [stagedImageAttachment],
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [stagedImageAttachment],
        },
      },
    });
  });

  it('rejects a durable SessionMedia reference supplied by an ingress caller', () => {
    expect(SessionUserMessageSendRequestSchema.safeParse({
      text: '',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{ ...pluginAttachment, content: { kind: 'sessionMedia', mediaId: 'media-1' } }],
        },
      },
    }).success).toBe(false);
  });

  it('never lets an ingress caller claim a dispatch resolution through the preserved arm', () => {
    const parsed = SessionUserMessageSendRequestSchema.safeParse({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [stagedImageAttachment],
          resolvedComposerAttachments: [{ ...pluginAttachment, data: { forged: true } }],
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.meta).toEqual({
      happierStructuredInputV1: {
        v: 1,
        composerAttachments: [stagedImageAttachment],
      },
    });
  });

  it('rejects whitespace-only text without an admitted composer attachment', () => {
    expect(SessionUserMessageSendRequestSchema.safeParse({
      text: '   ',
      meta: {},
    }).success).toBe(false);
  });

  it('drops untrusted structured local image input paths from RPC metadata', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            imageInputs: [
              {
                kind: 'localImage',
                path: '/tmp/private.png',
                mimeType: 'image/png',
              },
            ],
          },
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
        },
      },
    });
  });

  it('drops malformed structured input envelopes from RPC metadata', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happierStructuredInputV1: 'not-an-envelope',
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {},
    });
  });

  it('preserves uploaded local image metadata as canonical image inputs when the caller supplies a trusted attachment allowlist', () => {
    const meta = {
      happier: {
        kind: 'attachments.v1',
        payload: {
          attachments: [
            {
              name: 'screen.png',
              path: '.happier/uploads/messages/m1/screen.png',
              mimeType: 'image/png',
              sizeBytes: 42,
            },
          ],
        },
      },
      happierStructuredInputV1: {
        v: 1,
        imageInputs: [
          {
            kind: 'localImage',
            path: '.happier/uploads/messages/m1/screen.png',
            mimeType: 'image/png',
            provenance: { kind: 'sessionAttachmentUpload' },
          },
        ],
      },
    };

    expect(readAttachmentEnvelopeLocalImagePaths(meta)).toEqual(new Set(['.happier/uploads/messages/m1/screen.png']));
    expect(sanitizeSessionUserMessageSendMeta(meta, {
      allowedLocalImagePaths: new Set(['.happier/uploads/messages/m1/screen.png']),
    })).toMatchObject({
      happierStructuredInputV1: {
        v: 1,
        imageInputs: [
          {
            kind: 'localImage',
            path: '.happier/uploads/messages/m1/screen.png',
            provenance: { kind: 'sessionAttachmentUpload' },
          },
        ],
      },
    });
  });

  it('folds Remote Dev structured-input alias keys into the canonical metadata envelope', () => {
    expect(sanitizeSessionUserMessageSendMeta({
      happierVendorPluginMentions: [
        { vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' },
      ],
      happierSkillMentions: [
        { name: 'review', path: '/skills/review/SKILL.md', origin: 'codex_native' },
      ],
    })).toMatchObject({
      happierStructuredInputV1: {
        v: 1,
        vendorPluginMentions: [
          { vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' },
        ],
        skillMentions: [
          { name: 'review', path: '/skills/review/SKILL.md', origin: 'vendor', backendId: 'codex' },
        ],
      },
    });
  });

  it('drops a malformed mention element without discarding its siblings or the request', () => {
    // INV-4: malformed elements drop individually. The sanitizer runs inside a zod
    // `.transform`, so a `parse` that throws inside it escapes `safeParse` itself and the
    // request boundary fails with a raw exception instead of rejecting the one bad element.
    const parsed = SessionUserMessageSendRequestSchema.safeParse({
      text: 'review this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          skillMentions: [
            { name: 'good', path: '/skills/good/SKILL.md', origin: 'vendor' },
            { name: 'unreadable-origin', path: '/skills/other/SKILL.md', origin: 'wat' },
            { name: 'unusable', path: '/skills/broken/SKILL.md', backendId: 7 },
          ],
          vendorPluginMentions: [
            { vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' },
            { vendorPluginRef: 'plugin://drive@openai-curated', agentId: 7 },
          ],
        },
      },
    });

    expect(parsed.success).toBe(true);
    const envelope = parsed.success
      ? (parsed.data.meta as Record<string, unknown>).happierStructuredInputV1 as Record<string, unknown>
      : null;
    expect(envelope?.skillMentions).toEqual([
      { id: '/skills/good/SKILL.md', idSource: 'generated', name: 'good', path: '/skills/good/SKILL.md', origin: 'vendor' },
      { id: '/skills/other/SKILL.md', idSource: 'generated', name: 'unreadable-origin', path: '/skills/other/SKILL.md' },
    ]);
    expect(envelope?.vendorPluginMentions).toEqual([
      { vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' },
    ]);
  });
});

describe('SessionPendingMessageComposerAdmissionPrepareRequestV1Schema', () => {
  it('retains the exact source Composer while rejecting caller-private metadata and malformed refs', () => {
    const request = {
      localId: 'successor-1',
      text: 'Review this',
      structuredInput: { v: 1, composerAttachments: [pluginAttachment] },
      sourceComposerRef: { kind: 'pendingMessage', sessionId: 'source-session', localId: 'original-pending' },
    };
    expect(SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.parse(request))
      .toEqual(request);
    for (const sourceComposerRef of [
      { kind: 'pendingMessage', sessionId: 'source-session' },
      { kind: 'session', sessionId: 'source-session', privateMeta: {} },
      { kind: 'unknown', sessionId: 'source-session' },
    ]) {
      expect(SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.safeParse({
        ...request, sourceComposerRef,
      }).success).toBe(false);
    }
    expect(SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.safeParse({
      ...request, meta: { __happierComposerSourceRefV1: request.sourceComposerRef },
    }).success).toBe(false);
  });

  it('carries one stable Message identity and the complete draft attachment input', () => {
    const parsed = SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.parse({
      localId: 'successor-1',
      text: '',
      structuredInput: {
        v: 1,
        composerAttachments: [{
          ...pluginAttachment,
          content: { kind: 'stagedMedia', handle: stagedMediaHandle },
        }],
      },
    });

    expect(parsed.localId).toBe('successor-1');
    expect(parsed.structuredInput.composerAttachments?.[0]?.content?.kind).toBe('stagedMedia');
  });
});

describe('SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema', () => {
  it('carries exact source and child release intents through prepare and both settlement outcomes', () => {
    const stagedMediaReleaseIntents = [
      { kind: 'session', sessionId: 'target-session' },
      { kind: 'pendingMessage', sessionId: 'source-session', localId: 'original-pending' },
    ].map((composer, index) => ({
      handle: { ...stagedMediaHandle, id: `snapshot-${index}` },
      executionTarget: stagedMediaHandle.executionTarget,
      owner: stagedMediaHandle.owner,
      claimant: { composer, attachmentInstanceId: pluginAttachment.instanceId },
    }));
    const payload = {
      structuredInput: { v: 1, composerAttachments: [pluginAttachment] },
      stagedMediaHandles: stagedMediaReleaseIntents.map(({ handle }) => handle),
      stagedMediaReleaseIntents,
    };
    const prepared = SessionPendingMessageComposerAdmissionPrepareResponseV1Schema.parse({
      ok: true, text: 'Review', ...payload,
    });
    expect(prepared).toMatchObject({ stagedMediaReleaseIntents });
    const accepted = { sessionId: 'target-session', localId: 'successor-1', ...payload };
    expect(SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.parse(accepted)).toEqual(accepted);
    expect(SessionPendingMessageComposerAdmissionAbandonedRequestV1Schema.parse({
      ...accepted,
      sessionMediaCleanup: { workingDirectory: '/workspace', createdWorkspaceRelativePaths: [] },
    })).toMatchObject({ stagedMediaReleaseIntents });
    expect(SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.safeParse({
      ...accepted,
      stagedMediaHandles: Array.from({ length: 128 }, (_, index) => ({ ...stagedMediaHandle, id: `handle-${index}` })),
      stagedMediaReleaseIntents: Array.from({ length: 128 }, (_, index) => ({
        ...stagedMediaReleaseIntents[0], handle: { ...stagedMediaHandle, id: `handle-${index}` },
      })),
    }).success).toBe(true);
    expect(SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.safeParse({
      ...accepted, stagedMediaReleaseIntents: Array.from({ length: 129 }, () => stagedMediaReleaseIntents[0]),
    }).success).toBe(false);
    expect(SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.safeParse({
      ...accepted,
      stagedMediaReleaseIntents: [{ ...stagedMediaReleaseIntents[0], callerPrivateMeta: {} }],
    }).success).toBe(false);
  });

  it('accepts only the canonical accepted fact, never UI-asserted draft and admitted attachment lists', () => {
    const accepted = {
      sessionId: 'session-1',
      localId: 'pending-successor-1',
      structuredInput: {
        v: 1,
        composerAttachments: [pluginAttachment],
      },
      stagedMediaHandles: [stagedMediaHandle],
    };
    expect(SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.safeParse(accepted).success).toBe(true);
    expect(SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.safeParse({
      ...accepted,
      sessionMediaMetadata: {
        key: 'happier',
        envelope: {
          kind: 'session_media.v1',
          payload: {
            media: [{
              id: 'media-1',
              role: 'input',
              category: 'attachment',
              mediaKind: 'image',
              mimeType: 'image/png',
              name: 'hero.png',
              path: '.happier/uploads/hero.png',
              sizeBytes: 42,
              sha256: 'a'.repeat(64),
              origin: { source: 'user-upload' },
            }],
          },
        },
      },
    }).success).toBe(true);
    expect(SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.safeParse({
      localId: accepted.localId,
      draftAttachments: [{
        ...pluginAttachment,
        content: { kind: 'stagedMedia', handle: stagedMediaHandle },
      }],
      admittedAttachments: accepted.structuredInput.composerAttachments,
    }).success).toBe(false);
  });
});
