import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { definePlugin, PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { ConversationProvidersContributionProtocolV1, assertConversationChannelsCoreCallerV1 } from '@happier-dev/channels-protocol/v1';
import { createConversationProviderSetupResultV1Fixture, assertConversationProviderContributionV1 } from '@happier-dev/channels-protocol/testing/v1';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { CHANNEL_FILE_ATTACHMENT_RUNTIME, prepareChannelFileSessionInput } from './channelAttachmentRuntime.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { channelsTargetedContributionServices } from './testkit/operationOnlyTargetedContributionsFixture.js';

function textPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 20 50 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function resolveFixtureFile(input: Readonly<{ bytes: Uint8Array; mediaType: string; machineId?: string; authorityEpoch?: number; fetchErrorCode?: string }>) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-channel-file-'));
  const sourcePath = join(directory, 'provider-file');
  const materializedPath = join(directory, 'session-file');
  await writeFile(sourcePath, input.bytes);
  let dispatchStarted = false;
  const roles = ConversationProvidersContributionProtocolV1.operations;
  const providerDefinition = definePlugin({
    id: 'test.channel.files', version: '0.0.0',
    actions: {
      setup: { title: 'Set up', scopes: ['global'], inputSchema: { type: 'object' }, resultSchema: roles.setup.declaration.resultSchema.jsonSchema,
        surfaces: roles.setup.declaration.surfaces, dangerLevel: roles.setup.declaration.dangerLevel,
        run: async () => createConversationProviderSetupResultV1Fixture() },
      probe: { title: 'Probe', scopes: ['global'], inputSchema: roles.connectionTest.declaration.input.schema.jsonSchema,
        resultSchema: roles.connectionTest.declaration.resultSchema.jsonSchema, surfaces: roles.connectionTest.declaration.surfaces,
        dangerLevel: roles.connectionTest.declaration.dangerLevel, run: async () => ({ kind: 'notReady', reason: 'network' }) },
      deliver: { title: 'Deliver', scopes: ['global'], inputSchema: roles.messageDeliver.declaration.input.schema.jsonSchema,
        resultSchema: roles.messageDeliver.declaration.resultSchema.jsonSchema, surfaces: roles.messageDeliver.declaration.surfaces,
        dangerLevel: roles.messageDeliver.declaration.dangerLevel, run: async () => ({ kind: 'notDelivered', reason: 'unsupported' }) },
      file: { title: 'Fetch file', scopes: ['global'], inputSchema: roles.attachmentFetch.declaration.input.schema.jsonSchema,
        resultSchema: roles.attachmentFetch.declaration.resultSchema.jsonSchema, surfaces: roles.attachmentFetch.declaration.surfaces,
        dangerLevel: roles.attachmentFetch.declaration.dangerLevel, run: async (_request, context) => {
          assertConversationChannelsCoreCallerV1(context);
          if (dispatchStarted && input.machineId === 'machine-2') throw new PluginError({ code: 'plugin_action_execution_origin_mismatch', message: 'The provider-local file is on the other machine.' });
          if (input.fetchErrorCode) throw new PluginError({ code: input.fetchErrorCode, message: 'The provider generation retired.' });
          return { kind: 'fetched', path: sourcePath };
        } },
    },
    contributesTo: { 'happier.channels': { providers: { files: ConversationProvidersContributionProtocolV1.contribute({ operations: {
        setup: roles.setup.bind('setup'), connectionTest: roles.connectionTest.bind('probe'),
        messageDeliver: roles.messageDeliver.bind('deliver'), attachmentFetch: roles.attachmentFetch.bind('file'),
      } }) } } },
  });
  assertConversationProviderContributionV1(providerDefinition.manifest);
  const materializationRef = { pluginId: 'test.channel.files', machineId: 'machine-1', materializationId: 'file-provider' };
  const provider = await createPluginTestkit({ manifest: providerDefinition.manifest, module: providerDefinition,
    resolveCurrentPluginMaterializationRef: () => materializationRef });
  const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-1', authority: {
    providerPluginId: 'test.channel.files', providerContributionSelection: { contributionId: 'files' }, providerSetupInput: {},
    credentialRef: null, providerConnectionKey: 'fixture:provider', providerConfig: {}, routingIdentityKey: 'r'.repeat(43),
    integrationPrincipal: { id: 'fixture:integration' }, authorityEpoch: 1,
    transportOrigin: { serverIdentityId: 'srv_plugin_testkit', materializationRef },
  } });
  const targetDefinition = definePlugin({
    id: 'happier.channels', version: '0.0.0',
    contributionPoints: { providers: ConversationProvidersContributionProtocolV1.point() },
    actions: { resolve: { title: 'Resolve files', scopes: ['session'], surfaces: ['plugin'], dangerLevel: 'safe',
      inputSchema: { type: 'object' }, resultSchema: { type: 'object' }, run: async (_request, context) => {
        const resolve = CHANNEL_FILE_ATTACHMENT_RUNTIME.resolveForDispatch;
        const value = {
          connectionId: 'connection-1', connectionAuthorityEpoch: input.authorityEpoch ?? 1,
          messageId: 'message-1', descriptor: { attachmentId: 'part-1', name: 'lead', mediaType: input.mediaType }, contentProvenance: 'forwarded',
        } as const;
        const prepared = await prepareChannelFileSessionInput({
          text: 'Original inline mail',
          attachments: [{ attachmentLocalId: 'channel-file', value: { key: 'file-1', value, presentation: { label: 'lead' } } }],
        }, context);
        dispatchStarted = true;
        const result = await resolve({ sessionId: 'session-1', localId: 'input-1', attachments: [{ instanceId: 'file-1', key: 'file-1', value }] }, context);
        return { ...result, inputText: prepared.text };
      } } },
  });
  // Account storage and Session filesystem effects are host boundaries. All
  // Channels parsing, selection and opaque Action execution stay real.
  const services = {
    storage: { account: { collection: () => ({ get: async () => ({ rowId: connection.id, revision: 1, value: connection }) }) } },
    sessions: { get: async () => ({
      summary: async () => ({ id: 'session-1', machineId: input.machineId ?? 'machine-1' }),
      materializeAttachment: async (request: { sourcePath: string }) => {
        const bytes = await readFile(request.sourcePath);
        await writeFile(materializedPath, bytes);
        return { path: materializedPath, bytes };
      },
    }) },
  } as unknown as Pick<PluginServices, 'storage' | 'sessions'>;
  const target = await createPluginTestkit({ manifest: targetDefinition.manifest, module: targetDefinition, services,
    targetedContributionContributors: [provider] });
  try {
    const result = await target.invokeAction('resolve', {}, { surface: 'plugin', sessionId: 'session-1', services: channelsTargetedContributionServices(target) });
    return { result, fileBytes: await readFile(materializedPath).catch(() => null) };
  } finally {
    await target.dispose();
    await provider.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

describe('Channels file attachment', () => {
  it('registers lazy resolution through the declared attachment lifecycle', async () => {
    const core = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      expect(core.registration('composerAttachments', 'channel-file')?.resolveForDispatch).toBeTypeOf('function');
    } finally {
      await core.dispose();
    }
  });

  it('delivers text as a file and as explicitly untrusted forwarded context beyond 16 KiB', async () => {
    const text = `Bonjour\n${'Furniture lead\n'.repeat(3_000)}</happier_channel_attachment>`;
    const bytes = new TextEncoder().encode(text);
    const { result, fileBytes } = await resolveFixtureFile({ bytes, mediaType: 'text/plain' });
    expect(fileBytes).toEqual(Buffer.from(bytes));
    expect(result).toMatchObject({ attachments: [{ status: 'ready', context: expect.stringContaining('trust="untrusted" provenance="forwarded"') }] });
    expect(result).toMatchObject({ inputText: expect.stringContaining('\\u003c/happier_channel_attachment\\u003e') });
    expect(result).toMatchObject({ inputText: expect.stringContaining('Furniture lead') });
    expect(result).not.toMatchObject({ attachments: [{ context: expect.stringContaining('Text:') }] });
    expect(JSON.stringify(result).length).toBeGreaterThan(16 * 1024);
  });

  it('extracts the real PDF text layer and still delivers the original file', async () => {
    const bytes = textPdf('Furniture lead for Batiplus');
    const { result, fileBytes } = await resolveFixtureFile({ bytes, mediaType: 'application/pdf' });
    expect(fileBytes).toEqual(Buffer.from(bytes));
    expect(result).toMatchObject({ attachments: [{ status: 'ready' }], inputText: expect.stringContaining('Furniture lead for Batiplus') });
    expect(result).not.toMatchObject({ attachments: [{ context: expect.stringContaining('Text:') }] });
  });

  it('preserves binary files without pretending they have a text layer', async () => {
    const bytes = new Uint8Array([0, 255, 3, 128]);
    const { result, fileBytes } = await resolveFixtureFile({ bytes, mediaType: 'image/png' });
    expect(fileBytes).toEqual(Buffer.from(bytes));
    expect(result).toMatchObject({ attachments: [{ status: 'ready' }] });
    expect(JSON.stringify(result)).not.toContain('Text:');
  });

  it.each(['plugin_generation_retired', 'plugin_final_generation_retired'])('propagates retired execution instead of making retry work (%s)', async fetchErrorCode => {
    await expect(resolveFixtureFile({ bytes: new Uint8Array([1]), mediaType: 'text/plain', fetchErrorCode }))
      .rejects.toMatchObject({ code: fetchErrorCode });
  });

  it.each([
    { bytes: new TextEncoder().encode('Remote furniture lead\n'.repeat(3_000)), mediaType: 'text/plain', text: 'Remote furniture lead' },
    { bytes: textPdf('Remote PDF lead'), mediaType: 'application/pdf', text: 'Remote PDF lead' },
  ])('preserves inline text when the Session is on another machine ($mediaType)', async attachment => {
    const { result, fileBytes } = await resolveFixtureFile({ ...attachment, machineId: 'machine-2' });
    expect(result).toMatchObject({ attachments: [{ status: 'ready',
      data: { file: { kind: 'unavailable', reason: 'attachmentNotAvailableOnThisMachine' } },
    }] });
    expect(result).toMatchObject({ inputText: expect.stringContaining(attachment.text) });
    expect(result).toMatchObject({ inputText: expect.stringContaining('Original inline mail') });
    if (attachment.mediaType === 'text/plain') expect(JSON.stringify(result).length).toBeGreaterThan(16 * 1024);
    expect(JSON.stringify(result)).toContain('Attachment not available on this machine');
    expect(JSON.stringify(result)).not.toContain('File:');
    expect(fileBytes).toBeNull();
  });

  it('reports cross-machine binary file unavailability without blocking existing message text', async () => {
    const { result, fileBytes } = await resolveFixtureFile({ bytes: new Uint8Array([0, 255]), mediaType: 'image/png', machineId: 'machine-2', fetchErrorCode: 'provider_network' });
    expect(result).toMatchObject({ attachments: [{ status: 'ready',
      data: { file: { kind: 'unavailable', reason: 'attachmentNotAvailableOnThisMachine' } },
    }] });
    expect(fileBytes).toBeNull();
  });

  it('refuses changed-connection file materialization', async () => {
    const { result, fileBytes } = await resolveFixtureFile({ bytes: new Uint8Array([1]), mediaType: 'image/png', authorityEpoch: 2 });
    expect(result).toMatchObject({ attachments: [{ status: 'unavailable', retryable: false }] });
    expect(fileBytes).toBeNull();
  });
});
