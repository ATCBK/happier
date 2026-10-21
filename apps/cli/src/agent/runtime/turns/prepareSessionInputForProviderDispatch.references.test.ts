import { describe, expect, it } from 'vitest';
import { MENTION_KIND_V1, buildMentionRefForKindV1, HappierStructuredInputV1Schema } from '@happier-dev/protocol';
import { buildUploadedAttachment, readSessionAttachmentDescriptorsV1 } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';
import { readHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { AgentSessionInputFilesService } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildCodexAppServerTurnInput, resolveCodexBrowserImageStructuredInput } from '@happier-dev/plugins-codex/agent/runtime/appServer/turnInput';
import { buildOpenCodePromptParts } from '../../../../../../packages/plugins/opencode/src/agent/runtime/server/promptParts';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createSdkExecFixture, createPluginContextFixture, createTerminalHostFixture, createEventsFixture } from '../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import type { PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import { prepareSessionInputForProviderDispatch } from './prepareSessionInputForProviderDispatch';
import legacyMessageV02 from './prepareSessionInputForProviderDispatch.legacyMessage.fixture.json';

const uploads = ['first', 'second'].map(id => buildUploadedAttachment({ id, name: `${id}.png`,
  path: `.happier/uploads/messages/input/${id}.png`, mimeType: 'image/png', sizeBytes: 68, sha256: 'a'.repeat(64) }));
const media = { id: 'media', role: 'input', category: 'attachment', mediaKind: 'image', mimeType: 'image/png',
  name: 'media.png', path: '.happier/uploads/messages/input/media.png', sizeBytes: 68,
  sha256: 'b'.repeat(64), origin: { source: 'user-upload' } } as const;
const browserMedia = { mediaId: 'browser', mediaKind: 'image', width: 1, height: 1, sizeBytes: 68,
  file: { sessionId: 'session', storage: 'session', path: '.happier/uploads/artifacts/session/capture/browser.png',
    sha256: 'c'.repeat(64), mimeType: 'image/png' } } as const;
const imageText = 'First [first](happier-ref:attachment:first), then [second](happier-ref:attachment:second), then [media](happier-ref:attachment:media-chip).';
function imagePrompt(): PermissionModeQueuedPrompt {
  return { text: imageText, localId: 'input', attachments: uploads, sessionMedia: [media],
    structuredInput: HappierStructuredInputV1Schema.parse({ v: 1,
      imageInputs: uploads.map(upload => ({ ...upload.structuredInput, id: upload.id, kind: 'localImage' })),
      composerAttachments: [{ v: 1, instanceId: 'media-chip', attachment: { pluginId: 'acme.media', localId: 'image' },
        key: 'media', value: {}, presentation: { label: 'media.png', typeLabel: 'Image' }, content: { kind: 'sessionMedia', mediaId: media.id } }],
      browserContext: { contexts: [{ v: 1, contextId: 'browser', sourceViewId: 'view', sourceAdapterKind: 'chromiumSidecar',
        fidelity: 'cdp', capturedAtMs: 1, navigationGeneration: 1, lifecycleState: 'available', redactionLevel: 'metadataOnly',
        kind: 'browserScreenshot', media: browserMedia }], attachments: [{ v: 1, attachmentId: 'browser-attachment',
        contextId: 'browser', sourceViewId: 'view', capturedNavigationGeneration: 1, currentNavigationGeneration: 1, state: 'available' }] },
    }),
  };
}
const inputFiles: AgentSessionInputFilesService = { readVerifiedImage: async image => ({
  url: `data:image/png;base64,${Buffer.from(image.path ?? image.id).toString('base64')}`,
  mimeType: 'image/png', filename: image.path?.split('/').at(-1),
}) };

async function assertAgentImageOrder(prepared: Awaited<ReturnType<typeof prepareSessionInputForProviderDispatch>>) {
  const expected = [uploads[0]!.path, uploads[1]!.path, media.path, browserMedia.file.path];
  const text = prepared.requiredPrompt;
  expect(text).toContain('First [Image #1], then [Image #2], then [Image #3].');
  expect(text).not.toContain('happier-ref:');
  const referenceBlock = text.slice(text.indexOf('<happier_references v="1">'), text.indexOf('</happier_references>'));
  expect(referenceBlock).toContain(media.path);
  expect(referenceBlock).toContain('mime_type="image/png"');
  expect(referenceBlock).toContain(`size_bytes=${media.sizeBytes}`);
  const codex = buildCodexAppServerTurnInput({ text,
    structuredInput: await resolveCodexBrowserImageStructuredInput(prepared.structuredInput, inputFiles) });
  expect(JSON.stringify(codex)).not.toContain('happier-ref:');
  expect(codex.filter(item => item.type === 'localImage' || item.type === 'image').map(item =>
    item.type === 'localImage' ? item.path : item.type === 'image' ? Buffer.from(item.url.split(',')[1]!, 'base64').toString() : null)).toEqual(expected);
  const openCode = await buildOpenCodePromptParts({ text, structuredInput: prepared.structuredInput, inputFiles });
  expect(JSON.stringify(openCode)).not.toContain('happier-ref:');
  expect(openCode.filter(item => item.type === 'file').map(item => Buffer.from(item.url.split(',')[1]!, 'base64').toString())).toEqual(expected);
  const exec = createSdkExecFixture();
  const base = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
  const ctx = { ...base, agentRuntime: { ...base.agentRuntime, inputFiles } };
  const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/tmp/inline-reference-fixture', launchEnv: {}, happierSessionId: 'session' });
  try {
    await operations.sendProviderTurnPrompt(text, { structuredInput: prepared.structuredInput });
    const row = exec.written.find(value => value !== null && typeof value === 'object' && Reflect.get(value, 'type') === 'user');
    expect(row).toBeDefined();
    const record = row as { message: { content: { type: string; text?: string; source?: { data: string } }[] } };
    expect(record.message.content.filter(item => item.type === 'image').map(item => Buffer.from(item.source!.data, 'base64').toString())).toEqual(expected);
    expect(record.message.content[0]).toEqual({ type: 'text', text });
  } finally { await operations.disposeProviderSession(); }
}

describe('inline references at the final provider boundary', () => {
  it.each([false, true])('matches all three Agent image codecs after SessionMedia and browser images (native command=%s)', async providerNativeCommand => {
    const prompt = imagePrompt();
    const text = `${providerNativeCommand ? '/review ' : ''}${prompt.text}`;
    const prepared = await prepareSessionInputForProviderDispatch({ prompt, transformedUserText: text, providerNativeCommand,
      signal: new AbortController().signal, localId: 'input', services: { sessionId: 'session',
        resolveComposerAttachmentForDispatch: async request => ({ attachments: request.request.attachments.map(attachment => ({
          instanceId: attachment.instanceId, status: 'ready',
        })) }),
      },
    });
    await assertAgentImageOrder(prepared);
  });

  it('does not charge thirty upload listings against the resolved mention budget', async () => {
    const attachments = Array.from({ length: 30 }, (_, index) => buildUploadedAttachment({ id: `upload-${index}`,
      name: `report-${index}.txt`, path: `.happier/uploads/messages/input/${'folder/'.repeat(8)}report-${index}.txt`, sizeBytes: 10 }));
    const prepared = await prepareSessionInputForProviderDispatch({ prompt: { text: 'Analyze the files', localId: 'input', attachments,
      structuredInput: { v: 1 } }, transformedUserText: 'Analyze the files', providerNativeCommand: false,
      signal: new AbortController().signal, localId: 'input' });
    for (const attachment of attachments) expect(prepared.requiredPrompt.split(attachment.path)).toHaveLength(2);
    expect(prepared.requiredPrompt.match(/<happier_references v="1">/g)).toHaveLength(1);
  });

  it('retains the predecessor upload text once when the descriptor has no inline id', async () => {
    // Captured by executing the real predecessor buildAttachmentMessageMeta,
    // formatAttachmentsBlock, buildStructuredInputMetaOverrides and mergeMessageMetaOverrides
    // at 8a088dd70f57ccf43fade3543fb6a3e874bee12a (all three source paths clean).
    const { text, meta } = legacyMessageV02;
    const prepared = await prepareSessionInputForProviderDispatch({ prompt: { text, localId: 'legacy',
      structuredInput: readHappierStructuredInputV1FromMeta(meta) ?? undefined, attachments: readSessionAttachmentDescriptorsV1(meta) },
      transformedUserText: text, providerNativeCommand: false, signal: new AbortController().signal, localId: 'legacy' });
    expect(prepared.requiredPrompt.split('[attachments]')).toHaveLength(2);
    expect(prepared.requiredPrompt.split('.happier/uploads/messages/m1/notes.txt')).toHaveLength(2);
    expect(prepared.requiredPrompt).toContain('session_id="source-session"');
  });
  it.each([false, true])('projects inline tokens for native command=%s without losing command position', async providerNativeCommand => {
    const ref = buildMentionRefForKindV1(MENTION_KIND_V1.session, 'source-session');
    const token = `[Auth fix](happier-ref:${ref})`;
    const text = `${providerNativeCommand ? '/review ' : 'Compare '}${token} with [pasted](happier-ref:session:unbound)`;
    const prepared = await prepareSessionInputForProviderDispatch({
      prompt: { text, localId: 'input', structuredInput: { v: 1, mentions: [{
        kind: MENTION_KIND_V1.session, ref, label: 'Auth fix', token,
      }] } }, transformedUserText: text, providerNativeCommand,
      signal: new AbortController().signal, localId: 'input',
    });
    const prompt = prepared.requiredPrompt;
    expect(prompt).not.toContain('happier-ref:');
    expect(prompt).toContain('@Session "Auth fix" with pasted');
    expect(prompt.match(/<happier_references v="1">/g)).toHaveLength(1);
    expect(prompt).toContain('session_id="source-session"');
    if (providerNativeCommand) expect(prompt.startsWith('/review ')).toBe(true);
  });
});
