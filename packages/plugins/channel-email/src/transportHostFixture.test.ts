import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getConversationAttachmentIdRepresentationsV1, readConversationAttachmentIdV1 } from '@happier-dev/channels-protocol/v1';
import { simpleParser } from 'mailparser';
import { assertEmailTransportContributionV1 } from '@happier-dev/email-transports-protocol/testing/v1';
import { definePlugin, type JsonValue, type PluginInvocationContext, type PluginServices, type TargetedContributionPointRef, type TargetedContributionSnapshot } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { emailPlugin } from './plugin.js';
import { EMAIL_CHANNEL_ACTION_IDS as ids } from './constants.js';
import { channelsOperationOnlyTargetedContributionsFixture } from '../../channels/src/testkit/operationOnlyTargetedContributionsFixture.js';
import { CHANNELS_PLUGIN } from '../../channels/src/manifest.js';
import { CHANNEL_STATE_COLLECTION } from '../../channels/src/collections.js';
import { MemoryCollection } from '../../channels/src/testkit/memoryCollection.js';
import { createCurrentConversationConnectionFixture } from '../../channels/src/testkit/currentConnectionFixture.js';
import { EmailTransportsContributionProtocolV1 as protocol, EmailTransportFetchRawInputV1Schema,
  EmailTransportSubmitRawInputV1Schema, EmailTransportFindSentInputV1Schema,
  type EmailTransportSubmitRawInputV1 } from './transports.js';
import { ConversationAttachmentFetchResultV1Schema, ConversationPollResultV1Schema,
  MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS,
  ConversationPrincipalResolveResultV1Schema,
  ConversationTransportFactReportInputV1Schema, type ConversationTransportFactReportInputV1 } from '@happier-dev/channels-protocol/v1';

const mailbox = 'wilson@example.com';
const incoming = Buffer.from(['From: Alice <alice@example.com>', 'Message-ID: <incoming@example.com>',
  'References: <root@example.com>', 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com',
  'Reply-To: attacker@outside.com', 'Cc: other@example.com',
  'Subject: Re: Question', 'Content-Type: text/plain; charset=utf-8', '', 'ANSWER',
  'On Monday, Alice wrote:', '> HISTORY'].join('\r\n'));

async function fixture(options: { findSent?: boolean } = {}) {
  const sent = new Map<string, Uint8Array>();
  const submissions: EmailTransportSubmitRawInputV1[] = [];
  const messages = new Map<string, Uint8Array>([['opaque-incoming', incoming], ['<incoming@example.com>', incoming]]);
  const facts: ConversationTransportFactReportInputV1[] = [];
  let refs = ['opaque-incoming'];
  let forceNotFound = false;
  let retainedCatalog: ReturnType<PluginTestkit['readTargetedContributionFixture']> | undefined;
  let ambiguous = false;
  let lookupOverride: Uint8Array | undefined;
  let invokedAtMs = Date.now();
  const receivedAtMs = 1_792_000_000_000;
  function transportAction(role: keyof typeof protocol.operations, run: ActionHandler) {
    const d = protocol.operations[role].declaration;
    return { title: role, inputSchema: d.input.schema.jsonSchema, resultSchema: d.resultSchema.jsonSchema,
      surfaces: role === 'fetchRaw' ? [...d.surfaces, 'cli' as const] : d.surfaces, dangerLevel: d.dangerLevel, run };
  }
  const transportPlugin = definePlugin({ id: 'acme.email.fixture', version: '0.0.0', actions: {
    list: transportAction('listSince', async () => ({ kind: 'batch', refs, checkpointAfterBatch: { position: 1 } })),
    fetch: transportAction('fetchRaw', async (input): Promise<JsonValue> => {
      const { ref } = EmailTransportFetchRawInputV1Schema.parse(input);
      const raw = lookupOverride ?? messages.get(ref) ?? sent.get(ref);
      return raw ? { kind: 'raw', mimeBase64: Buffer.from(raw).toString('base64'), receivedAtMs } : { kind: 'notReady', reason: 'unsupported' };
    }),
    submit: transportAction('submitRaw', async (input): Promise<JsonValue> => {
      const request = EmailTransportSubmitRawInputV1Schema.parse(input);
      submissions.push(request);
      sent.set(request.messageId, Buffer.from(request.mimeBase64, 'base64'));
      return ambiguous ? { kind: 'outcomeUnknown' } : { kind: 'delivered', providerMessageIds: [request.messageId] };
    }),
    test: transportAction('connectionTest', async () => ({ kind: 'ready', mailbox })),
    ...(options.findSent === false ? {} : { find: transportAction('findSent', async (input): Promise<JsonValue> => {
      const { messageId } = EmailTransportFindSentInputV1Schema.parse(input);
      return !forceNotFound && sent.has(messageId) ? { kind: 'found', messageId } : { kind: 'notFound' };
    }) }),
  }, contributesTo: { 'happier.channel.email': { transports: { fixture: protocol.contribute({ operations: {
    listSince: protocol.operations.listSince.bind('list'), fetchRaw: protocol.operations.fetchRaw.bind('fetch'),
    submitRaw: protocol.operations.submitRaw.bind('submit'), connectionTest: protocol.operations.connectionTest.bind('test'),
    ...(options.findSent === false ? {} : { findSent: protocol.operations.findSent.bind('find') }),
  } }) } } } });
  assertEmailTransportContributionV1(transportPlugin.manifest);
  const transport = await createPluginTestkit({ manifest: transportPlugin.manifest, module: transportPlugin });
  const state = new MemoryCollection();
  const materializationRef = { pluginId: emailPlugin.manifest.id, machineId: 'fixture-machine', materializationId: 'fixture-email' };
  await state.put(createCurrentConversationConnectionFixture({ connectionId: connection.connectionId, authority: {
    providerPluginId: emailPlugin.manifest.id, providerContributionSelection: { contributionId: 'email-provider' },
    providerSetupInput: { ...config, credentialRef: null }, credentialRef: null, providerConfig: config,
    providerConnectionKey: connection.providerConnectionKey, routingIdentityKey: 'e'.repeat(43),
    transportOrigin: { serverIdentityId: 'srv_plugin_testkit', materializationRef }, integrationPrincipal: { id: mailbox }, authorityEpoch: 1,
  } }), { expectedRevision: 'absent' });
  await state.put({ id: 'fixture-binding', 'record-kind': 'binding', 'binding-id': 'fixture-binding', 'connection-id': connection.connectionId,
    v: 1, 'created-at': 1, 'updated-at': 1, payload: { endpoint: thread,
      target: { kind: 'session', sessionId: 'fixture-session', policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
        approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
      allowedPrincipalIds: ['alice@example.com'], allowBotSenders: false, inputMode: 'allAllowedMessages', inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: true, deletionState: 'none',
    } }, { expectedRevision: 'absent' });
  const storage = { account: { collection(definition: { id: string }) {
    if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected readiness Collection');
    return state;
  } } } as unknown as PluginServices['storage'];
  const coreFacts = await createPluginTestkit({ manifest: CHANNELS_PLUGIN.manifest, services: { storage },
    module: { activate(api) { return CHANNELS_PLUGIN.activate({ ...api, actions: { ...api.actions, register(id, run) {
      return api.actions.register(id, async (input: Parameters<typeof run>[0], context) => {
        const result = await run(input, context);
        if (id === 'provider/transport-fact-report-v1' && result !== null && typeof result === 'object'
          && 'kind' in result && (result.kind === 'recorded' || result.kind === 'rejoined')) {
          const { senderEligibility: _candidate, ...publicFact } = ConversationTransportFactReportInputV1Schema.parse(input);
          facts.push(publicFact);
        }
        return result;
      });
    } } }); } } });
  let email: PluginTestkit;
  // The testkit provides structural admission and real opaque Action handles,
  // but deliberately has no production catalog observer. Adapt that host boundary only.
  function withCatalog(context: PluginInvocationContext): PluginInvocationContext {
    const catalog = channelsOperationOnlyTargetedContributionsFixture(email, emailPlugin.contributionPoints.transports);
    return { ...context, invokedAtMs, services: { ...context.services, targetedContributions: {
      observeForSelf: <T>(point: TargetedContributionPointRef<T>, options: { onInvalidated: () => void }) => {
        const observation = catalog.observeForSelf<T>(point, options);
        return { ...observation, readCurrent: async () => retainedCatalog
          ? retainedCatalog as unknown as TargetedContributionSnapshot<T> : observation.readCurrent() };
      },
    } } };
  }
  email = await createPluginTestkit({ manifest: emailPlugin.manifest, targetedContributionContributors: [transport],
    actionTargets: [coreFacts], resolveCurrentPluginMaterializationRef: () => materializationRef,
    module: { activate(api) {
      return emailPlugin.activate({ ...api, actions: { ...api.actions,
        register: (id, run) => api.actions.register(id, (input: Parameters<typeof run>[0], context) => run(input, withCatalog(context))),
      } });
    } } });
  const channelsPlugin = definePlugin({ id: 'happier.channels', version: '0.0.0', actions: {
    invoke: { title: 'Invoke email provider', surfaces: ['cli'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Invoke fixture provider?' },
      run: (input, context) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid fixture invocation');
        // Array.isArray does not narrow readonly JSON arrays; the fixture's Action boundary has rejected them above.
        const request = input as Readonly<Record<string, JsonValue>>;
        if (typeof request.action !== 'string') throw new Error('Invalid fixture invocation');
        return context.services.actions.execute({ pluginId: emailPlugin.manifest.id, localId: request.action }, request.input ?? null);
      } },
  } });
  const channels = await createPluginTestkit({ manifest: channelsPlugin.manifest, module: channelsPlugin, actionTargets: [email] });
  return { sent, submissions, facts, receivedAtMs, setInvocationTime(value: number) { invokedAtMs = value; },
    setAmbiguous(value: boolean) { ambiguous = value; }, replaceFetched(raw: Uint8Array) { lookupOverride = raw; },
    setMessages(values: readonly (readonly [string, Uint8Array])[]) { for (const [ref, raw] of values) messages.set(ref, raw); refs = values.map(([ref]) => ref); },
    addMessage(ref: string, raw: Uint8Array) { messages.set(ref, raw); },
    setNotFound() { forceNotFound = true; },
    retainCatalog() { retainedCatalog = email.readTargetedContributionFixture(emailPlugin.contributionPoints.transports); return retainedCatalog; },
    releaseCatalog() { retainedCatalog = undefined; },
    retireTransport: () => transport.dispose(),
    invoke: (action: string, input: JsonValue) => channels.invokeAction('invoke', { action, input }),
    dispose: async () => { await channels.dispose(); await email.dispose(); await transport.dispose(); await coreFacts.dispose(); } };
}

const config = { mailbox, transport: { pluginId: 'acme.email.fixture', contributionId: 'fixture' }, transportConfig: {},
  trustStrategy: { kind: 'authenticationResults', authservId: 'mx.example.com' }, allowedDomains: ['example.com'] };
const connection = { v: 1, connectionId: 'email-fixture', providerConnectionKey: `email:${mailbox}`,
  providerConfigVersion: 1, providerConfig: config, credentialRef: null };
const thread = { kind: 'thread', audience: 'direct', id: '<root@example.com>', parentId: mailbox };
const delivery = { ...connection, endpoint: thread, content: { text: 'Reply' }, deliveryKey: 'fixture-reply',
  replyContext: { replyToMessageId: '<incoming@example.com>' }, mentionPolicy: 'suppress', linkPreviewPolicy: 'providerDefault' };

describe('email core with an external contributed raw transport', () => {
  it('keeps retained seed1 attachment evidence stable across the portable attachment codec extraction', async () => {
    // Original retained harness 3-wilson.eml, read-only from nl3 on 2026-10-21.
    // Store with LF; reconstruct its original RFC5322 CRLF bytes at the boundary.
    const raw = Buffer.from((await readFile(new URL('./email/fixtures/seed1-forwarded-attachments.eml', import.meta.url), 'utf8')).replace(/\r?\n/g, '\r\n'));
    const native = await simpleParser(raw, { skipImageLinks: true, skipHtmlToText: true, skipTextToHtml: true });
    const messageId = native.messageId;
    if (!messageId) throw new Error('Retained fixture has no Message-ID');
    // Exact pre-change derivation: dd247000f8^:channel-email/src/email/parse.ts.
    // mailparser flattens this 8bit inline message/rfc822; only its PDF is
    // returned as a file, under the native third MIME part.
    const retained = native.attachments.map((file, index) => ({
      attachmentId: `mime:${file.partId ?? index + 1}`,
      name: file.filename!, mediaType: file.contentType, byteLength: file.content.byteLength,
    }));
    expect(retained.map(file => file.attachmentId)).toEqual(['mime:3']);
    const f = await fixture();
    try {
      f.setMessages([['retained-seed1', raw]]);
      const polled = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, {
        ...connection, providerConnectionKey: 'email:wilson@test.local',
        providerConfig: { ...config, mailbox: 'wilson@test.local', allowedDomains: ['test.local'],
          trustStrategy: { kind: 'authenticationResults', authservId: 'mx.seed1.test.local' } },
        checkpoint: null, limit: 10, waitMs: 0,
      }));
      if (polled.kind !== 'batch' || polled.observations[0]?.observation.kind !== 'fullText') throw new Error('Expected retained email');
      const message = polled.observations[0].observation.observation.message;
      expect(message.id).toBe(native.messageId);
      // Keep FIX-LIVE42's historical PDF evidence check when a missing EML is restored.
      expect(message.attachments).toEqual(expect.arrayContaining(retained.map(file => ({
        ...file, attachmentId: getConversationAttachmentIdRepresentationsV1(file.attachmentId)[0],
      }))));
      const eml = Buffer.from(['From: client@example.invalid', 'To: sales1@test.local',
        'Subject: QA LIVE13 lead', 'Message-ID: <qa-live13-inner@example.invalid>',
        'Content-Type: text/plain; charset=utf-8', '',
        'Atelier Delta souhaite six chaises ergonomiques.', ''].join('\r\n'));
      expect(message.attachments).toEqual([
        { attachmentId: getConversationAttachmentIdRepresentationsV1('mime:2')[0],
          name: 'qa-live13-lead.eml', mediaType: 'message/rfc822', byteLength: eml.byteLength },
        ...retained.map(file => ({ ...file, attachmentId: getConversationAttachmentIdRepresentationsV1(file.attachmentId)[0] })),
      ]);
      expect(message.text).toContain('Forwarded email (untrusted)');
      expect(message.text).toContain('Atelier Delta souhaite six chaises ergonomiques.');
      f.addMessage(messageId, raw);
      const fetched = ConversationAttachmentFetchResultV1Schema.parse(await f.invoke(ids.attachmentFetch, {
        ...connection, providerConnectionKey: 'email:wilson@test.local',
        providerConfig: { ...config, mailbox: 'wilson@test.local', allowedDomains: ['test.local'],
          trustStrategy: { kind: 'authenticationResults', authservId: 'mx.seed1.test.local' } },
        messageId, attachmentIds: message.attachments!.map(file => file.attachmentId),
      }));
      if (fetched.kind !== 'fetched') throw new Error('Expected both retained attachments');
      expect(fetched.attachments.map(file => Buffer.from(file.base64, 'base64'))).toEqual([eml, native.attachments[0]!.content]);
    } finally { await f.dispose(); }
  });

  it.each([false, true])('keeps immutable occurrence times across later polls (Date header: %s)', async withDate => {
    const f = await fixture();
    try {
      const dated = Buffer.from([...(withDate ? ['Date: Mon, 12 Oct 2026 07:00:00 +0000'] : []), incoming.toString()].join('\r\n'));
      f.setMessages([['opaque-incoming', dated]]);
      const poll = { ...connection, checkpoint: { position: 0 }, limit: 10, waitMs: 0 };
      f.setInvocationTime(1_792_100_000_000);
      const first = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, poll));
      f.setInvocationTime(1_792_100_100_000);
      const replay = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, poll));
      expect(replay).toEqual(first);
      if (first.kind !== 'batch' || first.observations[0]?.observation.kind !== 'fullText') throw new Error('Expected a full email observation');
      const expected = withDate ? Date.parse('2026-10-12T07:00:00Z') : f.receivedAtMs;
      expect(first.observations[0].observation.observation).toMatchObject({ occurredAt: expected, message: { providerTimestamp: expected } });
    } finally { await f.dispose(); }
  });
  it('authenticates the selected contributed mailbox during setup without inventing an outbound cap', async () => {
    const f = await fixture();
    try {
      await expect(f.invoke(ids.setup, { ...config, credentialRef: { service: { pluginId: 'acme.email.fixture', localId: 'mail' }, accountId: mailbox } }))
        .resolves.toMatchObject({ providerConnectionKey: `email:${mailbox}` });
    } finally { await f.dispose(); }
  });

  it.each([
    { name: 'ordinary subject', subject: 'Re: Question', label: 'Re: Question' },
    { name: 'empty subject', subject: '', label: undefined },
    { name: 'long subject', subject: 'A'.repeat(MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS + 1),
      label: 'A'.repeat(MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS) },
  ])('receives a trusted thread with $name and strips only history already held by a binding', async ({ subject, label }) => {
    const f = await fixture();
    try {
      f.replaceFetched(Buffer.from(incoming.toString().replace('Subject: Re: Question', `Subject: ${subject}`)));
      const poll = { ...connection, checkpoint: null, limit: 10, waitMs: 0 };
      const first = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, poll));
      expect(first).toMatchObject({ kind: 'batch', observations: [{ observation: {
        kind: 'fullText', observation: { endpoint: thread, actor: { principalId: 'alice@example.com', kind: 'human' },
          message: { id: '<incoming@example.com>', text: expect.stringContaining('HISTORY') } },
      } }] });
      if (first.kind !== 'batch' || first.observations[0]?.observation.kind !== 'fullText') throw new Error('Expected a full email observation');
      expect(first.observations[0].observation.observation.endpoint.label).toBe(label);
      await expect(f.invoke(ids.observationsPoll, { ...poll, bindings: [{ endpoint: thread }] })).resolves.toMatchObject({
        observations: [{ observation: { observation: { message: { text: 'ANSWER' } } } }], checkpointAfterBatch: { position: 1 },
      });
    } finally { await f.dispose(); }
  });

  it('replies only to the authenticated author and refuses a mismatched Message-ID lookup', async () => {
    const f = await fixture();
    try {
      await expect(f.invoke(ids.messageDeliver, delivery)).resolves.toMatchObject({ kind: 'delivered' });
      const raw = [...f.sent.values()][0]!;
      const parsed = await simpleParser(Buffer.from(raw));
      expect(parsed.inReplyTo).toBe('<incoming@example.com>');
      expect(parsed.references).toEqual(['<root@example.com>', '<incoming@example.com>']);
      expect(parsed.to).toMatchObject({ value: [{ address: 'alice@example.com' }] });
      expect(parsed.cc).toBeUndefined();
      f.replaceFetched(Buffer.from(incoming.toString().replace('<incoming@example.com>', '<different@example.com>')));
      await expect(f.invoke(ids.messageDeliver, delivery)).resolves.toMatchObject({ kind: 'notDelivered', retry: 'never' });
      expect(f.sent.size).toBe(1);
    } finally { await f.dispose(); }
  });

  it('starts with HTML and reconciles an ambiguous submit through the same deterministic identity', async () => {
    const f = await fixture();
    try {
      f.setAmbiguous(true);
      const resolved = ConversationPrincipalResolveResultV1Schema.parse(await f.invoke(ids.principalResolve, {
        ...connection, endpoint: { kind: 'direct', audience: 'direct', id: mailbox }, query: 'Owner@Example.com',
      }));
      expect(resolved.kind).toBe('resolved');
      if (resolved.kind !== 'resolved') return;
      const html = `<h1>${'a'.repeat(120_000)}</h1>`;
      const start = { ...connection, endpoint: { kind: 'direct', audience: 'direct', id: mailbox },
        content: { text: 'Brief', html }, deliveryKey: 'fixture-start',
        newThread: { recipients: resolved.candidates.map(principal => principal.id), subject: 'Brief' }, mentionPolicy: 'suppress', linkPreviewPolicy: 'providerDefault' };
      await expect(f.invoke(ids.messageDeliver, start)).resolves.toMatchObject({ kind: 'outcomeUnknown' });
      const [messageId, raw] = [...f.sent.entries()][0]!;
      expect((await simpleParser(Buffer.from(raw))).html).toBe(html);
      expect(f.submissions[0]!.envelope.to).toEqual(['owner@example.com']);
      await expect(f.invoke(ids.deliveryReconcile, { ...connection, endpoint: start.endpoint, deliveryKey: start.deliveryKey }))
        .resolves.toMatchObject({ kind: 'delivered', providerMessageIds: [messageId], endpoint: { kind: 'thread', id: messageId, parentId: mailbox } });
      expect(f.sent.size).toBe(1);
      expect(f.submissions).toHaveLength(1);
      f.setAmbiguous(false);
      await expect(f.invoke(ids.messageDeliver, { ...start, deliveryKey: 'confirmed-start' }))
        .resolves.toMatchObject({ kind: 'delivered', endpoint: { kind: 'thread', audience: 'direct', parentId: mailbox } });
      f.setNotFound();
      await expect(f.invoke(ids.deliveryReconcile, { ...connection, endpoint: start.endpoint, deliveryKey: start.deliveryKey }))
        .resolves.toEqual({ kind: 'outcomeUnknown' });
      expect(f.submissions).toHaveLength(2);
    } finally { await f.dispose(); }
  });

  it('projects unknown senders, noise and self while recording content-free trust attention and malformed mail', async () => {
    const f = await fixture();
    const makeMail = (id: string | null, from: string, headers: readonly string[]) => Buffer.from([
      `From: ${from}`, ...(id === null ? [] : [`Message-ID: ${id}`]), 'References: <root@example.com>', ...headers, 'Content-Type: text/plain', '', 'Question',
    ].join('\r\n'));
    const trustedHeader = 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com';
    try {
      f.setMessages([
        ['spoof', makeMail('<spoof@example.com>', 'alice@example.com', [
          'Authentication-Results: attacker.invalid; dmarc=pass header.from=example.com', trustedHeader])],
        ['missing', makeMail('<missing@example.com>', 'alice@example.com', [])],
        ['noise', makeMail('<noise@example.com>', 'alice@example.com', [trustedHeader, 'Auto-Submitted: auto-replied'])],
        ['self', makeMail('<self@example.com>', mailbox, [trustedHeader])],
        ['malformed', makeMail(null, 'alice@example.com', [trustedHeader])],
      ]);
      const polled = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, { ...connection, checkpoint: null, limit: 10, waitMs: 0 }));
      expect(polled.kind).toBe('batch');
      if (polled.kind !== 'batch') return;
      const entries = polled.observations.map(entry => entry.observation);
      for (const index of [0, 1]) expect(entries[index]).toMatchObject({ observation: { actor: { kind: 'unknown', principalId: null } } });
      expect(entries[2]).toMatchObject({ observation: { actor: { kind: 'bot' } } });
      expect(entries[3]).toMatchObject({ observation: { actor: { isIntegrationSelf: true } } });
      expect(entries[4]).toMatchObject({ kind: 'routableNonAdmission', reason: 'unsupportedContent' });
      expect(entries[4]).not.toHaveProperty('shell.message.text');
      expect(polled.checkpointAfterBatch).toEqual({ position: 1 });
      expect(f.facts).toContainEqual(expect.objectContaining({ authorityEpoch: 1,
        fact: expect.objectContaining({ kind: 'providerReadiness', status: 'attention', code: 'providerPermissionMissing' }) }));
      expect(JSON.stringify(f.facts)).not.toContain('alice@example.com');
    } finally { await f.dispose(); }
  });

  it.each([
    ['external@example.com', [], false],
    ['alice@example.com', [], true],
    ['alice@example.com', ['Auto-Submitted: auto-replied'], false],
    [mailbox, [], false],
  ] as const)('scopes missing-marker readiness through the registered core for %s', async (from, headers, attention) => {
    const f = await fixture();
    try {
      f.setMessages([['missing', Buffer.from([`From: ${from}`, 'Message-ID: <missing@example.com>',
        'References: <root@example.com>', ...headers, 'Content-Type: text/plain', '', 'Question'].join('\r\n'))]]);
      const result = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, {
        ...connection, checkpoint: { position: 0 }, limit: 10, waitMs: 0,
      }));
      expect(result.kind).toBe('batch');
      expect(f.facts.length > 0).toBe(attention);
      expect(JSON.stringify(f.facts)).not.toContain(from);
    } finally { await f.dispose(); }
  });

  it('fetches stable nested and retained MIME attachment ids without trusting embedded authentication headers', async () => {
    const f = await fixture();
    const auth = 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com';
    const inner = ['From: client@outside.com', 'Message-ID: <inner@outside.com>', auth, 'Subject: Lead',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=inner', '', '--inner', 'Content-Type: text/html', '',
      '<p>Lead details</p><div class="gmail_signature"><img src="cid:logo"></div>', '--inner',
      'Content-Type: image/png', 'Content-ID: <logo>', 'Content-Disposition: inline; filename=logo.png',
      'Content-Transfer-Encoding: base64', '', 'eA==', '--inner', 'Content-Type: text/plain',
      'Content-Disposition: attachment; filename="../../lead.txt"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('nested lead file').toString('base64'), '--inner--', ''].join('\r\n');
    const outer = Buffer.from(['From: alice@example.com', 'Message-ID: <forward@example.com>', auth, 'Subject: Fwd: Lead',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=outer', '', '--outer', 'Content-Type: text/html', '',
      '<p>Process the lead.</p><div class="gmail_signature"><img src="cid:forwarder-logo"></div>', '--outer',
      'Content-Type: image/png', 'Content-ID: <forwarder-logo>', 'Content-Disposition: inline; filename=forwarder-logo.png',
      'Content-Transfer-Encoding: base64', '', 'eA==', '--outer', 'Content-Type: text/plain',
      'Content-Disposition: attachment; filename=outer.txt', '', 'Outer file', '--outer',
      'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename=lead.eml',
      'Content-Transfer-Encoding: base64', '', Buffer.from(inner).toString('base64'), '--outer--', ''].join('\r\n'));
    try {
      f.setMessages([['forward-ref', outer]]);
      f.addMessage('<forward@example.com>', outer);
      const pollInput = { ...connection, checkpoint: null, limit: 10, waitMs: 0 };
      const polled = ConversationPollResultV1Schema.parse(await f.invoke(ids.observationsPoll, pollInput));
      expect(polled.kind).toBe('batch');
      if (polled.kind !== 'batch') return;
      const entry = polled.observations[0]!.observation;
      expect(entry.kind).toBe('fullText');
      if (entry.kind !== 'fullText') return;
      expect(entry.observation.actor.principalId).toBe('alice@example.com');
      expect(entry.observation.message.contentProvenance).toBe('forwarded');
      expect(entry.observation.message.text).toContain('Lead details');
      const attachments = entry.observation.message.attachments!;
      expect(attachments.map(file => file.name)).not.toContain('forwarder-logo.png');
      expect(attachments.map(file => file.name)).toContain('logo.png');
      const attachment = attachments.find(file => file.name.endsWith('lead.txt'))!;
      expect(readConversationAttachmentIdV1(attachment.attachmentId, 'email')).toHaveLength(2);
      const fetched = ConversationAttachmentFetchResultV1Schema.parse(await f.invoke(ids.attachmentFetch, {
        ...connection, messageId: '<forward@example.com>', attachmentIds: [attachment.attachmentId],
      }));
      expect(fetched.kind).toBe('fetched');
      if (fetched.kind !== 'fetched') throw new Error('Expected an attachment batch');
      expect(Buffer.from(fetched.attachments[0]!.base64, 'base64').toString()).toBe('nested lead file');
      // The pre-extraction writer (5033889b2db, email/parse.ts) joined these
      // native MIME part references with '/'. Retained Session inputs keep it.
      const retainedId = readConversationAttachmentIdV1(attachment.attachmentId, 'email')!.join('/');
      await expect(f.invoke(ids.attachmentFetch, {
        ...connection, messageId: '<forward@example.com>', attachmentIds: [retainedId],
      })).resolves.toEqual({ kind: 'fetched', attachments: [{ attachmentId: retainedId, base64: fetched.attachments[0]!.base64 }] });
      f.replaceFetched(outer);
      await expect(f.invoke(ids.attachmentFetch, { ...connection, messageId: '<different@example.com>', attachmentIds: [attachment.attachmentId] }))
        .resolves.toMatchObject({ kind: 'notReady', reason: 'permissionMissing' });
      f.replaceFetched(Buffer.from(outer.toString().replace('dmarc=pass', 'dmarc=fail')));
      await expect(f.invoke(ids.attachmentFetch, { ...connection, messageId: '<forward@example.com>', attachmentIds: [attachment.attachmentId] }))
        .resolves.toMatchObject({ kind: 'notReady', reason: 'permissionMissing' });
      const untrusted = Buffer.from(outer.toString().replace(`${auth}\r\n`, '').replace('<forward@example.com>', '<untrusted-forward@example.com>'));
      f.setMessages([['untrusted-ref', untrusted]]);
      f.addMessage('<untrusted-forward@example.com>', untrusted);
      f.replaceFetched(untrusted);
      await expect(f.invoke(ids.observationsPoll, pollInput)).resolves.toMatchObject({ observations: [{ observation: {
        observation: { actor: { kind: 'unknown', principalId: null } },
      } }] });
      await expect(f.invoke(ids.attachmentFetch, { ...connection, messageId: '<untrusted-forward@example.com>', attachmentIds: [attachment.attachmentId] }))
        .resolves.toMatchObject({ kind: 'notReady', reason: 'permissionMissing' });
    } finally { await f.dispose(); }
  });

  it('keeps reconciliation unknown without findSent and rejects original handles from a retired contributor', async () => {
    const f = await fixture({ findSent: false });
    try {
      await expect(f.invoke(ids.deliveryReconcile, { ...connection, endpoint: thread, deliveryKey: 'unknown' }))
        .resolves.toEqual({ kind: 'outcomeUnknown' });
      const snapshot = f.retainCatalog();
      expect(snapshot.contributions[0]!.operations.connectionTest!.identity.contributor.pluginId).toBe('acme.email.fixture');
      await expect(f.invoke(ids.connectionTest, { ...connection, selectedTransport: 'checkpointedPull' })).resolves.toMatchObject({ kind: 'ready' });
      await f.retireTransport();
      await expect(f.invoke(ids.connectionTest, { ...connection, selectedTransport: 'checkpointedPull' }))
        .rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
      f.releaseCatalog();
      await expect(f.invoke(ids.observationsPoll, { ...connection, checkpoint: null, limit: 10, waitMs: 0 }))
        .rejects.toMatchObject({ code: 'email_transport_unavailable' });
    } finally { await f.dispose(); }
  });
});
