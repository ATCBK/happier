import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import { buildFixtureHappierUrl, createFixtureStore, createCredentialIssuer, createLeadChat,
  projectFixtureErrorLog, projectFixtureErrorResponse } from './fixture.mjs';
import { actionSchemas } from './leads-fixture/contracts.mjs';
import { activate, manifest } from './leads-fixture/index.ts';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

const analysis = { leadId: 'northstar', score: 84, summary: 'Strong fit', nextStep: 'Call Maya' };
const publicKey = Buffer.alloc(32, 1).toString('base64url');
const spawnTokenId = '11111111-1111-4111-8111-111111111111';
const sessionTokenId = '22222222-2222-4222-8222-222222222222';
const expiredTokenId = '33333333-3333-4333-8333-333333333333';
const leadSessionId = 'northstar-session';

test('the development fixture starts against current workspace SDK source', async () => {
  const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts.start, /(?:^|\s)--conditions=happier-source(?:\s|$)/);
  assert.match(packageJson.scripts.start, /(?:^|\s)--import\s+tsx(?:\s|$)/);
});

test('the fixture selects its SDK Home in every embed frame URL', () => {
  const url = new URL(buildFixtureHappierUrl(
    'http://happier-agent-qa-embed.localhost:19364/?happier_hmr=0&server=https%3A%2F%2Fstale.example',
    'http://happier-agent-qa-embed.localhost:19361',
  ));
  assert.equal(url.origin, 'http://happier-agent-qa-embed.localhost:19364');
  assert.equal(url.searchParams.get('happier_hmr'), '0');
  assert.equal(url.searchParams.get('server'), 'http://happier-agent-qa-embed.localhost:19361');
});

function ownedStore() {
  const store = createFixtureStore();
  store.attachLeadSession('salesperson', 'northstar', leadSessionId);
  return store;
}

test('the plugin uses only the host Action identity for backend replay', async () => {
  const store = ownedStore();
  const keys = [];
  const testkit = await createPluginTestkit({ manifest, module: { activate } });
  try {
    const registration = testkit.registration('actions', 'update-stage');
    assert.ok(registration);
    // The host invocation context and HTTP service are this plugin's system boundaries.
    const context = {
      invocationId: 'host-approved-operation', session: { id: leadSessionId },
      signal: new AbortController().signal,
      services: { http: { async request(request) {
        const key = request.headers['idempotency-key'];
        keys.push(key);
        const input = JSON.parse(new TextDecoder().decode(request.body));
        assert.equal(Object.hasOwn(input, 'invocationId'), false);
        const result = store.apply('update_stage', input, key, request.headers['x-happier-fixture-session-id']);
        return { status: 200, body: new TextEncoder().encode(JSON.stringify(result)) };
      } } },
    };
    const input = { leadId: 'northstar', stage: 'qualified' };
    await registration(input, context);
    await registration(input, { ...context, signal: new AbortController().signal });
    assert.deepEqual(keys, ['host-approved-operation', 'host-approved-operation']);
    assert.equal(store.listLeads('salesperson')[0].stageUpdates, 1);
    await assert.rejects(registration(input, { ...context, invocationId: undefined }), /fixture_invocation_required/);
    assert.equal(store.listLeads('salesperson')[0].stageUpdates, 1);
  } finally {
    await testkit.dispose();
  }
});

test('validates business Action input before changing the lead', () => {
  assert.deepEqual({ ...actionSchemas.record_analysis.parse(analysis) }, analysis);
  assert.throws(() => actionSchemas.record_analysis.parse({ ...analysis, invocationId: 'caller-id' }));
  assert.deepEqual({ ...actionSchemas.update_stage.parse({ leadId: 'northstar', stage: 'qualified' }) },
    { leadId: 'northstar', stage: 'qualified' });
  assert.throws(() => actionSchemas.update_stage.parse({ leadId: 'northstar', stage: 'qualified', invocationId: 'caller-id' }));
  const store = ownedStore();
  assert.throws(() => store.apply('record_analysis', { ...analysis, score: 101 }, 'invocation-1', leadSessionId));
  assert.equal(store.listLeads('salesperson')[0].analysis, null);
  assert.throws(() => store.apply('update_stage', { leadId: 'northstar', stage: 'invented' }, 'approval-1', leadSessionId));
  store.apply('record_analysis', analysis, 'invocation-1', leadSessionId);
  assert.deepEqual(store.listLeads('salesperson')[0].analysis, {
    score: 84, summary: 'Strong fit', nextStep: 'Call Maya',
  });
});

test('replays an invocation once and rejects key reuse for a different mutation', () => {
  const store = ownedStore();
  const result = store.apply('update_stage', { leadId: 'northstar', stage: 'qualified' }, 'approval-1', leadSessionId);
  assert.deepEqual(store.apply('update_stage', { leadId: 'northstar', stage: 'qualified' }, 'approval-1', leadSessionId), result);
  // A replay key is correlation, not ownership: even an exact retained key must not disclose its result.
  assert.throws(() => store.apply('update_stage', { leadId: 'northstar', stage: 'qualified' }, 'approval-1', 'unowned-session'), /session_forbidden/);
  store.attachLeadSession('other-salesperson', 'alpine', 'foreign-owned-session');
  assert.throws(() => store.apply('update_stage', { leadId: 'northstar', stage: 'qualified' }, 'approval-1', 'foreign-owned-session'), /lead_forbidden/);
  assert.equal(store.listLeads('salesperson')[0].stageUpdates, 1);
  assert.throws(() => store.apply('update_stage', { leadId: 'northstar', stage: 'won' }, 'approval-1', leadSessionId), /idempotency_conflict/);
  assert.throws(() => store.apply('record_analysis', analysis, '', leadSessionId), /idempotency_key_required/);
  assert.throws(() => store.apply('update_stage', { leadId: 'northstar', stage: 'won', invocationId: 'approval-2' }, 'approval-2', leadSessionId));
  assert.equal(store.listLeads('salesperson')[0].stage, 'qualified');
});

test('business callbacks require an owned session and refuse another salesperson\'s lead', () => {
  const store = ownedStore();
  assert.throws(() => store.apply('record_analysis', analysis, 'missing-session'), /session_forbidden/);
  assert.throws(() => store.apply('record_analysis', analysis, 'foreign-session', 'unowned-session'), /session_forbidden/);
  assert.throws(() => store.apply('update_stage', { leadId: 'alpine', stage: 'qualified' }, 'foreign-lead', leadSessionId), /lead_forbidden/);
  assert.equal(store.listLeads('other-salesperson')[0].stageUpdates, 0);
  store.claimCopilot('salesperson', 'copilot-session');
  store.apply('update_stage', { leadId: 'verdant', stage: 'contacted' }, 'copilot-update', 'copilot-session');
  assert.equal(store.listLeads('salesperson')[1].stage, 'contacted');
});

test('lead initialization reports a typed SDK failure with its retained Session and no exception text', async () => {
  const store = createFixtureStore();
  const creationInputs = [];
  const sendOptions = [];
  let rejectSend = true;
  const session = { id: leadSessionId, async send(message, options) {
    assert.equal(store.canOpenSession('salesperson', leadSessionId), true);
    assert.match(message, /Northstar|research team/);
    assert.match(message, /dev\.leads-fixture\/actions\/record-analysis/);
    sendOptions.push(options);
    if (rejectSend) throw Object.assign(new Error('sensitive transport detail'), {
      code: 'target_unavailable', status: 503,
    });
    store.apply('record_analysis', analysis, 'analysis-result', leadSessionId);
    return { status: 'accepted', localId: 'first-turn' };
  } };
  // The SDK is the fixture's network boundary; its Session handle is the public send contract.
  const happier = { embed: { async createSession(input, options) {
    creationInputs.push({ input, options });
    return session;
  } }, sessions: { get: () => session } };
  const failure = await createLeadChat({ happier, store, userId: 'salesperson', leadId: 'northstar' })
    .then(() => null, (error) => error);
  assert.deepEqual(projectFixtureErrorResponse(failure), {
    status: 503,
    body: { error: 'target_unavailable', sessionId: leadSessionId },
  });
  assert.doesNotMatch(JSON.stringify(projectFixtureErrorResponse(failure)), /sensitive transport detail/);
  assert.equal(store.listLeads('salesperson')[0].sessionId, leadSessionId);
  rejectSend = false;
  assert.equal(await createLeadChat({ happier, store, userId: 'salesperson', leadId: 'northstar' }), leadSessionId);
  assert.equal(creationInputs.length, 1);
  assert.equal(creationInputs[0].input.initialMessage, undefined);
  assert.ok(creationInputs[0].options.requestId);
  assert.ok(sendOptions[0].requestId);
  assert.notEqual(sendOptions[0].requestId, creationInputs[0].options.requestId);
  assert.deepEqual(sendOptions[1], sendOptions[0]);
  await assert.rejects(createLeadChat({ happier, store, userId: 'other-salesperson', leadId: 'northstar' }), /lead_forbidden/);
});

test('fixture failure diagnostics project only typed issue paths and codes', () => {
  const response = projectFixtureErrorResponse(Object.assign(new Error('private input value'), {
    code: 'invalid_parameters',
    details: [
      { path: ['organizationPlacement', 'sectionId'], code: 'invalid_type', message: 'private input value' },
      { path: ['organizationPlacement'], code: 'unrecognized_keys', keys: ['folderId'] },
    ],
  }));
  assert.deepEqual(response, {
    status: 400,
    body: { error: 'invalid_parameters', issues: [
      { path: ['organizationPlacement', 'sectionId'], code: 'invalid_type' },
      { path: ['organizationPlacement'], code: 'unrecognized_keys' },
    ] },
  });
  assert.doesNotMatch(JSON.stringify(response), /private input value|folderId/);
  assert.deepEqual(projectFixtureErrorLog(Object.assign(new Error('private input value'), {
    code: 'invalid_parameters', details: response.body.issues,
  })), {
    status: 400, error: 'invalid_parameters', issues: response.body.issues,
  });
  assert.deepEqual(projectFixtureErrorLog(new Error('private input value')), {
    status: 400, error: 'fixture_error',
  });
});

test('lead creation projects a typed SDK spawn failure without exception text', async () => {
  const store = createFixtureStore();
  const happier = {
    embed: { async createSession() {
      throw Object.assign(new Error('sensitive spawn detail'), {
        code: 'invalid_parameters',
        details: { issues: [
          { path: ['organizationPlacement', 'sectionId'], code: 'invalid_type', message: 'sensitive spawn detail' },
        ] },
        session: { id: leadSessionId },
        result: { type: 'error', code: 'invalid_parameters', retryable: false },
      });
    } },
    sessions: { get() { throw new Error('Unexpected retained Session'); } },
  };

  const failure = await createLeadChat({ happier, store, userId: 'salesperson', leadId: 'northstar' })
    .then(() => null, (error) => error);
  assert.deepEqual(projectFixtureErrorResponse(failure), {
    status: 400,
    body: { error: 'invalid_parameters', sessionId: leadSessionId,
      issues: [{ path: ['organizationPlacement', 'sectionId'], code: 'invalid_type' }] },
  });
  assert.doesNotMatch(JSON.stringify(projectFixtureErrorResponse(failure)), /sensitive spawn detail/);
  assert.equal(store.listLeads('salesperson')[0].sessionId, null);
});

test('an ambiguous initial send returns the retained Session for recovery', async () => {
  const store = createFixtureStore();
  const session = {
    id: leadSessionId,
    async send() {
      return { status: 'outcomeUnknown', localId: 'first-turn' };
    },
  };
  const happier = {
    embed: { async createSession() { return session; } },
    sessions: { get: () => session },
  };

  assert.equal(await createLeadChat({ happier, store, userId: 'salesperson', leadId: 'northstar' }), leadSessionId);
  assert.equal(store.listLeads('salesperson')[0].sessionId, leadSessionId);
});

test('lead creation identity is stable for retries but fresh after fixture state restarts', async () => {
  const observedRequestIds = [];
  const createHappier = () => ({ embed: { async createSession(_input, options) {
    observedRequestIds.push(options.requestId);
    throw Object.assign(new Error('private spawn detail'), {
      result: { type: 'error', code: 'spawn_failed', retryable: false },
    });
  } }, sessions: { get() { throw new Error('Unexpected retained Session'); } } });

  const firstStore = createFixtureStore();
  await assert.rejects(createLeadChat({ happier: createHappier(), store: firstStore,
    userId: 'salesperson', leadId: 'northstar' }), /spawn_failed/);
  await assert.rejects(createLeadChat({ happier: createHappier(), store: firstStore,
    userId: 'salesperson', leadId: 'northstar' }), /spawn_failed/);
  const replacementStore = createFixtureStore();
  await assert.rejects(createLeadChat({ happier: createHappier(), store: replacementStore,
    userId: 'salesperson', leadId: 'northstar' }), /spawn_failed/);

  assert.equal(observedRequestIds[0], observedRequestIds[1]);
  assert.notEqual(observedRequestIds[2], observedRequestIds[0]);
});

test('a created credential retry keeps attribution and establishes renewal ownership only after verified mint', async () => {
  const store = createFixtureStore();
  const calls = [];
  let rejectMint = false;
  const issuer = createCredentialIssuer({ store, embed: {
    async createCredential(input) {
      calls.push(input);
      if (rejectMint) throw new Error('api_token_child_invalid');
      return { tokenId: input.sessionId ? sessionTokenId : spawnTokenId, token: 'test-token', expiresAt: '2099-01-01T00:00:00.000Z' };
    },
  } });
  await issuer.issue('salesperson', { embedPublicKey: publicKey, reason: 'initial' });
  const created = { sessionId: 'new-session', embedPublicKey: publicKey, reason: 'created', createdByTokenId: spawnTokenId };
  rejectMint = true;
  await assert.rejects(issuer.issue('salesperson', created), /api_token_child_invalid/);
  assert.equal(store.canOpenSession('salesperson', 'new-session'), false);
  rejectMint = false;
  await issuer.issue('salesperson', created);
  await issuer.issue('salesperson', created);
  assert.equal(calls.at(-1).requireCreatedBy, spawnTokenId);
  await issuer.issue('salesperson', { sessionId: 'new-session', embedPublicKey: publicKey, reason: 'expiring' });
  assert.equal(calls.at(-1).requireCreatedBy, undefined);
  await assert.rejects(issuer.issue('other-salesperson', created), /session_forbidden/);
  await assert.rejects(issuer.issue('salesperson', { sessionId: 'foreign-session', embedPublicKey: publicKey, reason: 'open' }), /session_forbidden/);
});

test('an expired new-chat issuance cannot claim a session', async () => {
  const store = createFixtureStore();
  const issuer = createCredentialIssuer({ store, embed: {
    async createCredential() {
      return { tokenId: expiredTokenId, token: 'test-token', expiresAt: '1970-01-01T00:00:00.000Z' };
    },
  } });
  await issuer.issue('salesperson', { embedPublicKey: publicKey, reason: 'initial' });
  await assert.rejects(issuer.issue('salesperson', {
    sessionId: 'new-session', embedPublicKey: publicKey, reason: 'created', createdByTokenId: expiredTokenId,
  }), /session_forbidden/);
  assert.equal(store.copilotSessionId('salesperson'), null);
});
