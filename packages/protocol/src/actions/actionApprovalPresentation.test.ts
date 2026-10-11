import { describe, expect, it } from 'vitest';

import { describeApprovalActionFields } from './actionApprovalPresentation.js';
import { getActionSpec } from './actionSpecs.js';
import { readActionSchemaTopLevelFieldNames } from './actionCliProjection.js';
import { MACHINE_PRESET_ACTION_IDS_V1 } from '../machines/managed/machinePresetActionIdsV1.js';
import { MANAGED_MACHINE_ACTION_IDS_V1 } from '../machines/managed/actionIdsV1.js';
import { MACHINE_POOL_ACTION_IDS_V1 } from '../machines/pools/actionsV1.js';

describe('approval field presentation', () => {
  it('lets the widget Action own a human approval summary with names instead of raw structure', () => {
    const input = {
      surface: {
        serverId: 'srv_home',
        accountId: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e',
        owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'qaf1-usage' },
      },
      instance: {
        v: 1,
        id: 'qaf1-usage-b',
        definition: { kind: 'artifact', artifactId: 'a2881e01' },
        bindings: {},
        displayName: 'Qaf1 Usage b',
      },
      size: 'small',
    };

    expect(getActionSpec('widgets.item.add').approvalPresentation?.summary(input)).toBe(
      'Add “Qaf1 Usage b” (small) to Usage · Main area.',
    );
  });

  it('gives a structured JSON value readable labelled entries beside its exact literal', () => {
    const intent = { kind: 'create', board: { title: 'Launch plan', boardId: null, tags: ['ui', 'qa'], items: [{ title: 'Ship' }] } };
    const presentation = describeApprovalActionFields({ actionId: 'boards.apply', actionArgs: { intent } });
    const row = presentation.rows.find((candidate) => candidate.path === 'intent');
    // The literal stays exact (admission and copy read it); people read the entries.
    expect(row).toMatchObject({ kind: 'value', value: JSON.stringify(intent) });
    expect(row && row.kind === 'value' ? row.entries : undefined).toEqual([
      { label: 'Kind', value: 'Create', depth: 0 },
      { label: 'Board', value: null, depth: 0 },
      { label: 'Title', value: 'Launch plan', depth: 1 },
      { label: 'Board id', value: 'null', depth: 1 },
      { label: 'Tags', value: 'ui, qa', depth: 1 },
      { label: 'Items', value: null, depth: 1 },
      { label: '1', value: null, depth: 2 },
      { label: 'Title', value: 'Ship', depth: 3 },
    ]);
  });

  it('names Home and Account references, reads kinds and sizes as words, and keeps versions and empty values aside', () => {
    const surface = { serverId: 'srv_home', accountId: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e',
      owner: { kind: 'corePage', pageId: 'usage', area: 'main' }, layoutId: 'qaf1-usage' };
    const instance = { v: 1, id: 'qaf1-usage-b', definition: { kind: 'artifact', artifactId: 'a2881e01' }, bindings: {}, displayName: 'Usage b' };
    const presentation = describeApprovalActionFields({ actionId: 'widgets.item.add', actionArgs: { surface, instance, size: 'small' } });
    const entries = (path: string) => {
      const row = presentation.rows.find((candidate) => candidate.path === path);
      return row && row.kind === 'value' ? row.entries : undefined;
    };
    // References read by their names; target ids stay in view; versions and empty values stay present, aside.
    expect(entries('surface')).toEqual([
      { label: 'Server id', value: 'srv_home', depth: 0, reference: { kind: 'home', id: 'srv_home' } },
      { label: 'Account id', value: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e', depth: 0,
        reference: { kind: 'account', id: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e' } },
      { label: 'Owner', value: null, depth: 0 },
      { label: 'Kind', value: 'Core page', depth: 1 },
      { label: 'Page id', value: 'usage', depth: 1 },
      { label: 'Area', value: 'main', depth: 1 },
      { label: 'Layout id', value: 'qaf1-usage', depth: 0 },
    ]);
    expect(entries('instance')).toEqual([
      { label: 'V', value: '1', depth: 0, technical: true },
      { label: 'Id', value: 'qaf1-usage-b', depth: 0 },
      { label: 'Definition', value: null, depth: 0 },
      { label: 'Kind', value: 'Artifact', depth: 1 },
      { label: 'Artifact id', value: 'a2881e01', depth: 1 },
      { label: 'Bindings', value: '{}', depth: 0, technical: true },
      { label: 'Display name', value: 'Usage b', depth: 0 },
    ]);
    // A chosen option reads by its label, as the form that set it.
    expect(presentation.rows.find((candidate) => candidate.path === 'size')).toMatchObject({ value: 'Small' });
  });

  it('keeps a target id argument in view, so an approval shows exactly what it acts on', () => {
    const presentation = describeApprovalActionFields({ actionId: 'widgets.group.create', actionArgs: {
      surface: { serverId: 'srv_home', accountId: 'acct-1' }, groupId: 'usage-group', title: 'Usage' } });
    const row = presentation.rows.find((candidate) => candidate.path === 'groupId');
    expect(row).toEqual({ kind: 'value', path: 'groupId', title: 'Group id', value: 'usage-group' });
  });

  it('shows custom Provider target, endpoint and proposed template without credential or header values', () => {
    const actionArgs = { action: 'createCustom', connectionId: 'pc_review', enable: true, savedSecretId: 'private-secret-reference',
      template: { v: 1, name: 'Review source', endpointTemplates: [{ id: 'messages', protocol: 'anthropic',
        baseUrl: 'http://127.0.0.1:46435/v1', publicHeaders: { 'x-private': 'private-header-value' },
        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
        credential: { kind: 'apiKey', required: true, transports: [{ id: 'api-key', protocols: ['anthropic'], uses: ['runtime'],
          destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' } }] },
        catalog: { source: 'manual', manualModelPolicy: 'allowed' } }, manualModels: [] };
    const presentation = describeApprovalActionFields({ actionId: 'providers.connections.create_custom', actionArgs });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'connectionId', value: 'pc_review' }),
      expect.objectContaining({ path: 'template.name', value: 'Review source' }),
      expect.objectContaining({ path: 'template.endpointTemplates.[].baseUrl', value: 'http://127.0.0.1:46435/v1' }),
      expect.objectContaining({ path: 'template.endpointTemplates.[].protocol', value: 'anthropic' }),
      expect.objectContaining({ path: 'template.credential', value: expect.stringContaining('"required":true') }),
    ]));
    expect(JSON.stringify(presentation)).not.toMatch(/private-secret-reference|private-header-value/);
    expect(presentation.unrepresentable).toBeNull();
    const spec = getActionSpec('providers.connections.create_custom');
    const admitted = spec.inputSchema.parse(actionArgs);
    const observed = spec.projectObservationInput?.(admitted);
    expect(JSON.stringify(observed)).not.toMatch(/private-secret-reference|private-header-value/);
    const fromPreview = describeApprovalActionFields({ actionId: spec.id, actionArgs: admitted,
      preview: { actionId: spec.id, actionArgs: observed } });
    expect(fromPreview).toEqual(presentation);
  });

  it('shows exact gateway slot replacement and explicit placement/helper clears', () => {
    const purposeBindingDefaults = { upstream: { kind: 'group', service: { pluginId: 'example.auth', localId: 'subscription' }, groupId: 'pool-new' } };
    const presentation = describeApprovalActionFields({ actionId: 'providers.connections.update', actionArgs: {
      action: 'update', connectionId: 'pc_gateway', expectedRevision: 2, displayName: 'Shared gateway',
      deployment: { kind: 'managedLocal', purposeBindingDefaults }, gatewayPlacement: null, claudeHelperModels: null,
    } });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'displayName', value: 'Shared gateway' }),
      expect.objectContaining({ path: 'deployment.purposeBindingDefaults', value: JSON.stringify(purposeBindingDefaults) }),
      expect.objectContaining({ path: 'gatewayPlacement', value: 'null' }),
      expect.objectContaining({ path: 'claudeHelperModels', value: 'null' }),
    ]));
    expect(presentation.unrepresentable).toBeNull();
  });

  it('shows Connected account label clearing and exact pool targets', () => {
    const account = { service: { pluginId: 'example.auth', localId: 'subscription' }, accountId: 'account-a' };
    const presentation = describeApprovalActionFields({ actionId: 'connectedServices.accounts.rename', actionArgs: { account, label: '' } });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'account', value: JSON.stringify(account) }),
      expect.objectContaining({ path: 'label', value: '\"\"' }),
    ]));
  });

  it('keeps exact deletion targets and endpoint reset visible without exposing credential-bearing URLs', () => {
    expect(describeApprovalActionFields({ actionId: 'providers.connections.delete', actionArgs: {
      action: 'delete', connectionId: 'pc_remove',
    } }).rows).toContainEqual(expect.objectContaining({ path: 'connectionId', value: 'pc_remove' }));
    const endpoint = { action: 'setEndpointOverride', connectionId: 'pc_review', expectedRevision: 3,
      scope: 'account', endpointTemplateId: 'messages', baseUrl: null };
    expect(describeApprovalActionFields({ actionId: 'providers.connections.endpoint.set', actionArgs: endpoint }).rows)
      .toContainEqual(expect.objectContaining({ path: 'baseUrl', value: 'null' }));
    for (const baseUrl of ['https://user:recognizable-secret@example.test/v1',
      'https://example.test/v1?api_key=recognizable-secret', 'https://example.test/v1#recognizable-secret']) {
      const spec = getActionSpec('providers.connections.endpoint.set');
      const observed = spec.projectObservationInput?.({ ...endpoint, baseUrl });
      expect(JSON.stringify(observed)).not.toContain('recognizable-secret');
      expect(describeApprovalActionFields({ actionId: spec.id, actionArgs: { ...endpoint, baseUrl } }).rows)
        .not.toContainEqual(expect.objectContaining({ path: 'baseUrl' }));
    }
  });

  it('shows draft Test and contributed endpoint overrides from their real admitted input shapes', () => {
    const spec = getActionSpec('providers.probe');
    const draft = spec.inputSchema.parse({ kind: 'draft', draftConnectionId: 'pc_draft', machineId: 'computer',
      template: { v: 1, name: 'Draft source', endpointTemplates: [{ id: 'messages', protocol: 'anthropic',
        baseUrl: 'http://127.0.0.1:46435/v1', capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown',
          statefulResponses: 'unknown', reasoningControls: 'unknown' } }], catalog: { source: 'manual', manualModelPolicy: 'allowed' } },
      savedSecretId: null, actionNonce: 'test-action-nonce' });
    expect(describeApprovalActionFields({ actionId: spec.id, actionArgs: draft }).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'draftConnectionId', value: 'pc_draft' }),
      expect.objectContaining({ path: 'template.name', value: 'Draft source' }),
      expect.objectContaining({ path: 'template.endpointTemplates.[].baseUrl', value: 'http://127.0.0.1:46435/v1' }),
      expect.objectContaining({ path: 'template.credential', value: 'null' }),
    ]));
    const overrides = [{ endpointTemplateId: 'messages', baseUrl: 'https://override.example.test/' }];
    const contributed = describeApprovalActionFields({ actionId: 'providers.connections.create_contribution', actionArgs: {
      action: 'createContribution', connectionId: 'pc_builtin', contributionKey: 'example.provider/source',
      displayName: 'Work source', savedSecretId: 'private-secret-reference', enable: true,
      authoringReview: { endpointOverrides: overrides },
    } });
    expect(contributed.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'displayName', value: 'Work source' }),
      expect.objectContaining({ path: 'authoringReview.endpointOverrides', value: JSON.stringify(overrides) }),
    ]));
    expect(JSON.stringify(contributed)).not.toContain('private-secret-reference');
  });
  it('declares every machine-family input operand for exact-target approval review', () => {
    for (const actionId of [...MACHINE_PRESET_ACTION_IDS_V1, ...MACHINE_POOL_ACTION_IDS_V1, ...MANAGED_MACHINE_ACTION_IDS_V1]) {
      const spec = getActionSpec(actionId);
      const declared = new Set(spec.inputHints?.fields.map(field => field.path.split('.')[0]));
      const paths = readActionSchemaTopLevelFieldNames(spec.inputSchema);
      if (paths) expect([...paths].filter(path => !declared.has(path)), actionId).toEqual([]);
    }
  });

  it('shows preset configuration, deletion target and the reviewed managed effect in approval details', () => {
    const preset = { homeId: 'home', id: 'preset', name: 'Personal machine', owner: { kind: 'account', accountId: 'account' },
      recipe: { provider: { pluginId: 'machine.example', localId: 'vm' }, schemaVersion: 1, name: 'Work VM', choices: { cpu: 2 } },
      controller: { machineId: 'controller', installationId: 'installation' },
      environment: { setupScript: 'echo ready' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    const presentation = describeApprovalActionFields({ actionId: 'machines.presets.create', actionArgs: preset });
    expect(presentation.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'name', value: preset.name }),
      expect.objectContaining({ path: 'recipe', value: JSON.stringify(preset.recipe) }),
      expect.objectContaining({ path: 'controller', value: JSON.stringify(preset.controller) }),
      expect.objectContaining({ path: 'environment', value: JSON.stringify(preset.environment) }),
    ]));
    expect(describeApprovalActionFields({ actionId: 'machines.pools.delete', actionArgs: { poolId: 'pool', expectedRevision: 3 } }).rows)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'poolId', value: 'pool' }),
        expect.objectContaining({ path: 'expectedRevision', value: '3' })]));
    expect(describeApprovalActionFields({ actionId: 'machines.managed.delete', actionArgs: {
      homeId: 'home', managedId: 'managed', when: 'now', intent: 'delete', expectedRevision: 4, reviewedDependencies: true,
    } }).rows).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'managedId', value: 'managed' }),
      expect.objectContaining({ path: 'intent', value: 'delete' }), expect.objectContaining({ path: 'reviewedDependencies', value: 'true' })]));
    const deferred = describeApprovalActionFields({ actionId: 'machines.managed.delete', actionArgs: {
      homeId: 'home', managedId: 'managed', when: 'after-idle', intent: 'delete', reviewedDependencies: true, afterMs: 0,
    } });
    expect(deferred.unrepresentable).toBeNull();
    expect(deferred.rows).toContainEqual(expect.objectContaining({ path: 'afterMs', value: '0' }));
    const selection = { kind: 'one-off', homeId: 'home', controller: preset.controller };
    const acquire = describeApprovalActionFields({ actionId: 'machines.managed.acquire', actionArgs: { selection } });
    expect(acquire.unrepresentable).toBeNull();
    expect(acquire.rows).toContainEqual(expect.objectContaining({ path: 'selection', value: JSON.stringify(selection) }));
  });

  it('represents the validated guide starter without waiving ordinary prompt content', () => {
    const starter = describeApprovalActionFields({ actionId: 'prompt_doc.create', actionArgs: { starter: 'happier_guide' } });
    expect(starter.unrepresentable).toBeNull();
    expect(starter.rows).toContainEqual(expect.objectContaining({ path: 'starter', value: 'happier_guide' }));
    for (const actionArgs of [{}, { starter: 'unknown' }, { title: 'Incomplete' }]) {
      expect(describeApprovalActionFields({ actionId: 'prompt_doc.create', actionArgs }).unrepresentable)
        .toMatchObject({ reason: 'missing_required_context' });
    }
  });
  it.each(['', ' \n '])('represents explicitly blank prompt content (%j) without admitting missing content', markdown => {
    const empty = describeApprovalActionFields({ actionId: 'prompt_doc.create', actionArgs: { title: 'Blank document', markdown } });
    expect(empty.unrepresentable).toBeNull();
    expect(empty.rows).toContainEqual(expect.objectContaining({ path: 'markdown', value: JSON.stringify(markdown) }));
    expect(describeApprovalActionFields({ actionId: 'prompt_doc.create', actionArgs: { title: 'Missing content' } }).unrepresentable)
      .toMatchObject({ path: 'markdown', reason: 'missing_required_context' });
  });
  it('makes update-clear visible while leaving ordinary Markdown review verbatim', () => {
    for (const markdown of ['', ' \n ']) {
      const cleared = describeApprovalActionFields({ actionId: 'prompt_doc.update', actionArgs: { artifactId: 'document', title: 'Document', markdown } });
      expect(cleared.unrepresentable).toBeNull();
      expect(cleared.rows).toContainEqual(expect.objectContaining({ path: 'markdown', value: JSON.stringify(markdown) }));
    }
    const markdown = '# Reviewed content';
    for (const actionId of ['prompt_doc.create', 'prompt_doc.update']) {
      const ordinary = describeApprovalActionFields({ actionId, actionArgs: { artifactId: 'document', title: 'Document', markdown } });
      expect(ordinary.rows).toContainEqual(expect.objectContaining({ path: 'markdown', value: markdown }));
    }
  });
  it.each([undefined, null])('keeps absent or undeclared-null required context (%j) unavailable', markdown => {
    expect(describeApprovalActionFields({ actionId: 'prompt_doc.create', actionArgs: { title: 'Document', markdown } }).unrepresentable)
      .toMatchObject({ path: 'markdown', reason: 'missing_required_context' });
  });
  it('retains the declared-null context exception', () => {
    expect(describeApprovalActionFields({ actionId: 'settings.set', actionArgs: { anchor: 'example', value: null } }).unrepresentable)
      .toBeNull();
  });
  it('represents a declared-null create revision across input alternatives without admitting an absent revision', () => {
    const actionArgs = { itemId: 'note', expectedItemRevision: null, item: { v: 1, title: 'Note', frame: 'card',
      height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative',
        document: { version: 1, root: { kind: 'markdown', text: 'Note' } } } } };
    expect(describeApprovalActionFields({ actionId: 'session.board.item.upsert', actionArgs }).unrepresentable).toBeNull();
    const { expectedItemRevision: _revision, ...absent } = actionArgs;
    expect(describeApprovalActionFields({ actionId: 'session.board.item.upsert', actionArgs: absent }).unrepresentable)
      .toMatchObject({ path: 'expectedItemRevision', reason: 'missing_required_context' });
  });
  it.each(['account', 'team', 'group'])('keeps %s access principals as data, not Session references', (kind) => {
    const principal = { kind, ...(kind === 'group' ? { teamId: 'team-1' } : {}), [`${kind}Id`]: 'session-shaped-id' };
    const rows = describeApprovalActionFields({ actionId: 'machines.access.grant.set',
      actionArgs: { serverId: 'home', machineId: 'machine', principal, level: 'view' } }).rows;
    expect(rows.find(row => row.path === 'principal')).toMatchObject({ kind: 'value', path: 'principal', value: JSON.stringify(principal) });
    expect(rows.find(row => row.path === 'principal')).not.toHaveProperty('reference');
  });

  it('identifies the declared Voice Session target with its own Home', () => {
    const rows = describeApprovalActionFields({ actionId: 'ui.voice_global.start', actionArgs: {
      target: { kind: 'session', sessionAddress: { serverId: 'other-home', sessionId: 'session-1' } }, expectedAttempt: null,
    } }).rows;
    expect(rows.find(row => row.path === 'target')).toMatchObject({
      reference: { kind: 'session', id: 'session-1', serverId: 'other-home' },
    });
  });

  it('does not interpret an arbitrary configuration object as a typed target', () => {
    const value = { kind: 'session', sessionId: 'session-1', empty: '', absent: null };
    const rows = describeApprovalActionFields({ actionId: 'settings.set', actionArgs: { anchor: 'example', value } }).rows;
    expect(rows.find(row => row.path === 'value')).toMatchObject({ value: JSON.stringify(value) });
    expect(rows.find(row => row.path === 'value')).not.toHaveProperty('reference');
  });
  it.each([
    ['ordered members', ['account-b', 'account-a']],
    ['an explicit empty list', []],
  ])('preserves %s as structured JSON rather than flattening or hiding the mutation', (_label, accountIds) => {
    const presentation = describeApprovalActionFields({
      actionId: 'connectedServices.pools.reorder',
      actionArgs: {
        group: { serviceId: 'service-a', groupId: 'pool-a' },
        accountIds,
        expectedGeneration: '1',
      },
    });

    expect(presentation.rows).toContainEqual(expect.objectContaining({
      kind: 'value', path: 'accountIds', value: JSON.stringify(accountIds),
    }));
    expect(presentation.unrepresentable).toBeNull();
  });

  it('treats required input withheld by live-only custody as present without disclosing it', () => {
    const presentation = describeApprovalActionFields({
      actionId: 'notifications.webhooks.signingSecret.set',
      actionArgs: {
        channelId: 'webhook-a',
        secret: 'recognizable-live-only-secret',
      },
    });

    expect(presentation).toEqual({
      rows: [
        { kind: 'value', path: 'channelId', title: 'Webhook id', value: 'webhook-a' },
      ],
      unrepresentable: null,
    });
    expect(JSON.stringify(presentation)).not.toContain('recognizable-live-only-secret');
  });

  it('applies live-only withholding to non-secret structured configuration fields', () => {
    const presentation = describeApprovalActionFields({
      actionId: 'connectedServices.configuration.replace',
      actionArgs: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai' },
        modeId: 'configured',
        expectedRevision: 'before',
        values: { endpoint: 'https://private-endpoint.test' },
        secretValues: { token: 'recognizable-private-replacement' },
      },
    });

    expect(presentation.unrepresentable).toBeNull();
    expect(JSON.stringify(presentation)).not.toContain('private-endpoint');
    expect(JSON.stringify(presentation)).not.toContain('private-replacement');
  });

  it('shows worker policy, service placement and operation cancellation operands without requiring absent union-arm context', () => {
    const workspace = { serverId: 'home', refId: 'checkout' };
    const disabled = { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} };
    const enabled = { enabled: true, destination: { kind: 'pool', poolId: '39a2d0b4-c6ce-4e85-a674-1b8c5824d425', selection: 'automatic' },
      unavailable: 'fail', allowAdHoc: true, scriptOverrides: { build: 'workers' } };
    const primary = { runsOn: { kind: 'primary' }, unavailable: 'fail' };
    const workers = { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker' } }, unavailable: 'primary' };
    const cases = [
      ['projects.worker.preferences.set', { workspace, expectedRevision: 'absent', expected: { kind: 'absent' }, next: disabled }],
      ['projects.worker.preferences.set', { workspace, expectedRevision: 3, expected: { kind: 'value', value: disabled }, next: enabled }],
      ['projects.worker.preferences.reset', { workspace, expectedRevision: 4, expected: { kind: 'value', value: enabled } }],
      ['machines.worker.policy.set', { serverId: 'home', machineId: 'worker', expectedMetadataVersion: 5,
        expectedPolicy: { accepting: true, runAtMost: null }, policy: { accepting: false, runAtMost: 2 } }],
      ['projects.service.placement.set', { workspace, serviceName: 'web', expectedRevision: 'absent',
        expected: { kind: 'absent' }, value: primary }],
      ['projects.service.placement.set', { workspace, serviceName: 'web', expectedRevision: 6,
        expected: { kind: 'value', value: primary }, value: workers }],
      ['action.operations.cancel', { serverId: 'home', machineId: 'worker', operationId: 'operation' }],
    ] as const;
    for (const [actionId, raw] of cases) {
      const actionArgs = getActionSpec(actionId).inputSchema.parse(raw);
      const presentation = describeApprovalActionFields({ actionId, actionArgs });
      expect(presentation.unrepresentable, actionId).toBeNull();
      for (const [path, value] of Object.entries(actionArgs)) {
        expect(presentation.rows, `${actionId}:${path}`).toContainEqual(expect.objectContaining({
          path, value: typeof value === 'object' ? JSON.stringify(value) : String(value),
        }));
      }
    }
    expect(describeApprovalActionFields({ actionId: 'action.operations.cancel',
      actionArgs: { serverId: 'home', operationId: 'operation' } }).unrepresentable)
      .toMatchObject({ path: 'machineId', reason: 'missing_required_context' });
  });

  it('reads an encoded file in a visual by its size, never by its bytes', () => {
    const contentBase64 = Buffer.from('<main>Build health</main>'.repeat(60)).toString('base64');
    const item = { v: 1, title: 'Build health', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
      source: { kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64 } } } } };
    const presentation = describeApprovalActionFields({ actionId: 'session.board.item.upsert',
      actionArgs: { sessionId: 'session-1', itemId: 'build-health', expectedItemRevision: null, destination: 'transcript', item } });
    const row = presentation.rows.find((candidate) => candidate.path === 'item');
    const entries = row && row.kind === 'value' ? row.entries ?? [] : [];
    expect(entries.some((entry) => entry.value?.includes(contentBase64))).toBe(false);
    expect(entries).toContainEqual({ label: 'Size', value: '1.5 KB', depth: 4 });
    // Admission and copy still read the exact literal.
    expect(row).toMatchObject({ kind: 'value', value: JSON.stringify(item) });
  });
});
