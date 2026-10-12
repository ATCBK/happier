import { describe, expect, it } from 'vitest';

import { ActivityWebhookPayloadV1Schema, buildActivityWebhookPayload, MachineVitalsPushRoutingDataV1Schema,
  buildGuardStopWarningPushDataV1, GuardStopWarningPushDataV1Schema, readGuardStopWarningPushActionV1,
  isGuardStopWarningCurrentV1 } from './webhookPayload.js';
import { readUsageNoticeArtifactV1 } from './usageNoticeArtifactV1.js';

describe('guard warning routing and withdrawal', () => {
  it('binds each action and dismissal to the exact Session or terminal occurrence', () => {
    const session = buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'machine',
      sessionId: 'session', rule: 'idle_sessions', stopAt: 300_000 });
    const home = { serverId: 'admitted-home' };
    expect(readGuardStopWarningPushActionV1(session, 'keepRunning', home)).toEqual({
      actionId: 'machines.guard.idleStop.keepRunning', input: { machineId: 'machine', sessionId: 'session', serverId: home.serverId } });
    expect(readGuardStopWarningPushActionV1(session, 'stopNow', home)).toEqual({ actionId: 'session.stop', input: { sessionId: 'session', serverId: home.serverId } });
    // @ts-expect-error A JavaScript consumer can violate the required admitted-Home context.
    expect(readGuardStopWarningPushActionV1(session, 'keepRunning', {})).toBeNull();
    const state = { v: 1, kind: 'stopping', rule: 'idle_sessions', stopAt: 300_000 };
    expect(isGuardStopWarningCurrentV1(session, { machineId: 'machine', sessionId: 'session', state })).toBe(true);
    expect(isGuardStopWarningCurrentV1(session, { machineId: 'machine', sessionId: 'session', state: undefined })).toBe(false);
    expect(isGuardStopWarningCurrentV1(session, { machineId: 'machine', sessionId: 'session', state: { ...state, stopAt: 600_000 } })).toBe(false);
    expect(isGuardStopWarningCurrentV1(session, { machineId: 'machine', sessionId: 'session', state: { v: 1, kind: 'configured', ceilingBytes: 4096 } })).toBe(false);
    const terminal = buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'machine',
      terminalId: 'terminal', terminalKey: 'shell', rule: 'idle_terminals', stopAt: 300_000 });
    const current = { machineId: 'machine', terminalId: 'terminal', terminalKey: 'shell',
      state: { v: 1, kind: 'stopping', rule: 'idle_terminals', stopAt: 300_000 } };
    expect(isGuardStopWarningCurrentV1(terminal, current)).toBe(true);
    expect(readGuardStopWarningPushActionV1(terminal, 'stopNow', home)).toEqual({
      actionId: 'machines.terminal.close', input: { machineId: 'machine', terminalId: 'terminal', serverId: home.serverId } });
    expect(isGuardStopWarningCurrentV1(terminal, { ...current, terminalId: 'reopened-terminal' })).toBe(false);
    expect(isGuardStopWarningCurrentV1(terminal, { ...current, state: undefined })).toBe(false);
    expect(GuardStopWarningPushDataV1Schema.safeParse({ ...terminal, sessionId: 'invented' }).success).toBe(false);
    expect(readGuardStopWarningPushActionV1({ ...session, notificationId: 'another-occurrence' }, 'stopNow', home)).toBeNull();
    expect(readGuardStopWarningPushActionV1({ ...terminal, actions: { ...terminal.actions,
      stopNow: { actionId: 'machines.terminal.close', input: { machineId: 'machine', terminalId: 'another-terminal' } } } }, 'stopNow', home)).toBeNull();
  });
});

describe('machine vitals Inbox notices', () => {
  const common = { topic: 'resource_limit', machineId: 'machine-1', at: 120_000, since: 0,
    workingSessionCount: 2, guardEnabled: false };
  const notices = [
    { ...common, kind: 'memory_pressure', evidence: { level: 'elevated', sustainMs: 120_000, swapUsedBytes: 10 } },
    { ...common, kind: 'cpu_busy', evidence: { abovePct: 90, sustainMs: 120_000, busyPct: 95 } },
    { ...common, kind: 'disk_nearly_full', volumeId: 'volume-1', evidence: {
      freeBytes: 10, totalBytes: 1000, threshold: { freeFraction: 0.1 } } },
  ];
  it.each(notices)('opens started and recovered $kind through the existing Artifact reader', notice => {
    for (const phase of ['started', 'recovered']) {
      const value = { ...notice, phase };
      const header = { v: 1, kind: 'usage_notice.v1', title: 'Machine resources', status: 'open', notice: value };
      expect(readUsageNoticeArtifactV1({ header, body: JSON.stringify({ v: 1, notice: value }) })).toEqual(header);
    }
  });
  it('drops retired stored fields while rejecting mismatched evidence and divergent Artifact copies', () => {
    const value = { ...notices[0], phase: 'started' };
    const read = (notice: unknown, bodyNotice: unknown = notice) => readUsageNoticeArtifactV1({
      header: { v: 1, kind: 'usage_notice.v1', title: 'Resources', status: 'open', notice },
      body: JSON.stringify({ v: 1, notice: bodyNotice }),
    });
    expect(read({ ...value, evidence: notices[1]!.evidence })).toBeNull();
    const expected = read(value);
    expect(read({ ...value, privateSessionTitle: 'secret' })).toEqual(expected);
    expect(read({ ...value, evidence: { ...notices[0]!.evidence, extra: 1 } })).toEqual(expected);
    expect(read(value, { ...value, phase: 'recovered' })).toBeNull();
  });
  it('keeps routing bound to the notice and rejects unknown routing authority', () => {
    const machineVitals = { ...notices[0], phase: 'started' };
    const data = { topic: 'resource_limit', kind: 'memory_pressure', phase: 'started', machineId: 'machine-1',
      notificationId: 'resource-1', nextSteps: ['review_processes'], machineVitals,
      serverUrl: 'https://home.example.test' };
    expect(MachineVitalsPushRoutingDataV1Schema.parse(data)).toEqual(data);
    expect(MachineVitalsPushRoutingDataV1Schema.safeParse({ ...data, machineId: 'other-machine' }).success).toBe(false);
    expect(MachineVitalsPushRoutingDataV1Schema.safeParse({ ...data, action: 'stop_everything' }).success).toBe(false);
  });
});

describe('buildActivityWebhookPayload', () => {
  it('builds a ready webhook payload with session navigation', () => {
    const payload = buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 123,
      topic: 'ready',
      content: {
        title: 'Review branch',
        body: 'The branch is ready to review.',
      },
      session: {
        sessionId: 'session-1',
        title: 'Review branch',
      },
      metadata: {
        providerLabel: 'Codex',
      },
    });

    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(payload.navigation).toEqual({ sessionId: 'session-1' });
  });

  it('builds a request webhook payload without raw input fields', () => {
    const payload = buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 456,
      topic: 'permission_request',
      content: {
        title: 'Deploy fix',
        body: 'Claude asks permission to use Bash\nCommand: git',
      },
      session: {
        sessionId: 'session-2',
        title: 'Deploy fix',
      },
      request: {
        requestId: 'request-1',
        kind: 'permission',
        toolName: 'Bash',
        toolDetails: 'Command: git',
      },
    });

    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(payload.navigation).toEqual({ sessionId: 'session-2', requestId: 'request-1' });
    expect(JSON.stringify(payload)).not.toContain('toolInput');
  });

  it('accepts connected-service quota and account-switch webhook topics', () => {
    for (const topic of [
      'connected_service_account_switch',
      'connected_service_credential_health',
      'connected_service_quota_blocked',
      'connected_service_quota_recovered',
    ] as const) {
      const payload = buildActivityWebhookPayload({
        channelId: 'webhook-primary',
        createdAt: 789,
        topic,
        content: {
          title: 'Provider account updated',
          body: 'A provider account state changed.',
        },
        session: {
          sessionId: 'session-3',
          title: 'Quota recovery',
        },
      });

      expect(ActivityWebhookPayloadV1Schema.parse(payload).topic).toBe(topic);
    }
  });

  it('builds a strict workflow Run update with exact Run navigation and no private content', () => {
    const payload = buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 790,
      topic: 'workflow_run_update',
      content: {
        title: 'Workflow needs attention',
        body: 'A workflow Run was interrupted and needs attention.',
      },
      workflowRun: {
        runId: 'run-42',
        updateKind: 'interrupted',
        reason: { code: 'approval_required' },
      },
    });

    expect(ActivityWebhookPayloadV1Schema.parse(payload)).toEqual(payload);
    if (payload.topic !== 'workflow_run_update') throw new Error('Expected workflow webhook payload');
    expect(payload).toEqual({
      v: 1,
      channelId: 'webhook-primary',
      createdAt: 790,
      topic: 'workflow_run_update',
      content: {
        title: 'Workflow needs attention',
        body: 'A workflow Run was interrupted and needs attention.',
      },
      workflowRun: {
        runId: 'run-42',
        updateKind: 'interrupted',
        reason: { code: 'approval_required' },
      },
      navigation: { runId: 'run-42' },
    });
    expect(ActivityWebhookPayloadV1Schema.safeParse({
      ...payload,
      workflowRun: { ...payload.workflowRun, prompt: 'private prompt' },
    }).success).toBe(false);
    expect(ActivityWebhookPayloadV1Schema.safeParse({
      ...payload,
      workflowRun: {
        ...payload.workflowRun,
        reason: { code: 'approval_required', message: 'private diagnostic' },
      },
    }).success).toBe(false);
    expect(ActivityWebhookPayloadV1Schema.safeParse({
      ...payload,
      workflowRun: { ...payload.workflowRun, updateKind: 'invented' },
    }).success).toBe(false);
  });

  it('rejects a workflow topic without the workflow arm', () => {
    const ordinary = buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 791,
      topic: 'ready',
      content: { title: 'Ready', body: 'Ready.' },
      session: { sessionId: 'session-1' },
    });

    expect(ActivityWebhookPayloadV1Schema.safeParse({
      ...ordinary,
      topic: 'workflow_run_update',
      navigation: { runId: 'run-42' },
    }).success).toBe(false);
  });
});
