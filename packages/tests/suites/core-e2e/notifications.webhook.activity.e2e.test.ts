import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
} from '@happier-dev/protocol';
import { dispatchActivityNotificationAsync } from '../../../../apps/cli/src/notifications/activity/dispatchActivityNotification';
import type { ActivityNotificationEvent } from '../../../../apps/cli/src/notifications/activity/activityNotificationEvent';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { startActivityWebhookCaptureServer } from '../../src/testkit/activityWebhookCapture';
import { readAccountSettingsV1, writeAccountSettingsV1 } from '../../src/testkit/accountSettingsHttp';
import { buildCanonicalWebhookAccountSettings } from '../../src/testkit/activityWebhookSettings';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: webhook activity notifications', () => {
  let server: StartedServer | null = null;
  let webhookServer: Awaited<ReturnType<typeof startActivityWebhookCaptureServer>> | null = null;

  afterEach(async () => {
    await webhookServer?.stop().catch(() => {});
    webhookServer = null;
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('delivers ready activity to a configured webhook channel using persisted account settings', async () => {
    const testDir = run.testDir(`notifications-webhook-ready-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    webhookServer = await startActivityWebhookCaptureServer();

    const auth = await createTestAuth(server.baseUrl);
    await writeAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: {
        schemaVersion: 2,
        notificationsSettingsV1: {
          v: 1,
          pushEnabled: false,
          ready: true,
          readyIncludeMessageText: true,
          permissionRequest: true,
          userActionRequest: true,
          foregroundBehavior: 'full',
        },
        notificationChannelsV1: [
          {
            v: 1,
            id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
            kind: 'expo_push',
            enabled: false,
            topics: {
              ready: true,
              permissionRequest: true,
              userActionRequest: true,
            },
            readyIncludeMessageText: true,
          },
          {
            v: 1,
            id: 'webhook-primary',
            kind: 'webhook',
            enabled: true,
            url: webhookServer.url,
            signingSecret: {
              _isSecretValue: true,
              value: 'ready-secret',
            },
            topics: {
              ready: true,
              permissionRequest: false,
              userActionRequest: false,
            },
            readyIncludeMessageText: false,
          },
        ],
      },
    });

    const { settings } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const dispatchResult = await dispatchActivityNotificationAsync({
      settings,
      event: {
        topic: 'ready',
        sessionId: 'session-ready-1',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });
    expect(dispatchResult).toEqual({
      attemptedChannels: 1,
      deliveredChannels: 1,
    });

    const webhookRequest = await webhookServer.nextPayload();
    expect(webhookRequest.headers['x-happier-signature-256']).toMatch(/^sha256=[a-f0-9]{64}$/);
    const payload = webhookRequest.payload;
    expect(payload.topic).toBe('ready');
    if (payload.topic === 'workflow_run_update' || payload.topic === 'follow_update') {
      throw new Error('Expected an ordinary ready webhook payload');
    }
    expect(payload.navigation).toEqual({ sessionId: 'session-ready-1' });
    expect(payload.session).toEqual({
      sessionId: 'session-ready-1',
      title: 'Review branch',
    });
    expect(payload.request).toBeUndefined();
    expect(payload.content).toEqual({
      title: 'Review branch',
      body: 'Codex is waiting for your command',
    });
  }, 240_000);

  it('includes permission and question context by default and hides it when explicitly disabled', async () => {
    const testDir = run.testDir(`notifications-webhook-request-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    webhookServer = await startActivityWebhookCaptureServer();
    const auth = await createTestAuth(server.baseUrl);
    const command = 'git status --short && git diff -- src/main.ts';
    const rationale = 'Inspect the changed entry point before proposing a fix.';
    const questionDetails = [
      'Which change should I inspect?', 'Entry point', 'Inspect application startup',
      'Tests', 'Inspect regression coverage', 'Which checks should I run?',
      'Unit', 'Run focused unit checks', 'Integration', 'Run the composed flow',
    ];

    for (const requestIncludeMessageText of [true, false, undefined]) {
      await writeAccountSettingsV1({
        baseUrl: server.baseUrl, token: auth.token,
        settings: {
          schemaVersion: 2,
          notificationsSettingsV1: { v: 1, pushEnabled: false, permissionRequest: true, userActionRequest: true },
          attentionDeliveryPolicyV1: {
            v: 1,
            channels: {
              expo_push: { enabled: false },
              webhook: {
                enabled: true,
                events: {
                  permission_request: { previewBehavior: 'include_preview' },
                  user_action_request: { previewBehavior: 'include_preview' },
                },
              },
            },
          },
          notificationChannelsV1: [{
            v: 1, id: 'webhook-primary', kind: 'webhook', enabled: true, url: webhookServer.url,
            signingSecret: { _isSecretValue: true, value: 'permission-secret' },
            topics: { ready: false, permissionRequest: true, userActionRequest: true },
            ...(requestIncludeMessageText === undefined ? {} : { requestIncludeMessageText }),
          }],
        },
      });
      const { settings } = await readAccountSettingsV1({ baseUrl: server.baseUrl, token: auth.token });
      const events = [{
        topic: 'permission_request', sessionId: 'session-perm-1', sessionTitle: 'Review change',
        agentDisplayName: 'Claude', requestId: `permission-${requestIncludeMessageText}`, toolName: 'Bash',
        toolInput: { command, rationale },
      }, {
        topic: 'user_action_request', sessionId: 'session-perm-1', sessionTitle: 'Review change',
        agentDisplayName: 'Claude', requestId: `question-${requestIncludeMessageText}`, toolName: 'AskUserQuestion',
        toolInput: { questions: [{
          header: 'Scope', question: questionDetails[0], multiSelect: false,
          options: [
            { label: questionDetails[1], description: questionDetails[2] },
            { label: questionDetails[3], description: questionDetails[4] },
          ],
        }, {
          header: 'Checks', question: questionDetails[5], multiSelect: true,
          options: [
            { label: questionDetails[6], description: questionDetails[7] },
            { label: questionDetails[8], description: questionDetails[9] },
          ],
        }] },
      }] satisfies ActivityNotificationEvent[];
      for (const event of events) {
        const result = await dispatchActivityNotificationAsync({ settings, event });
        expect(result).toEqual({ attemptedChannels: 1, deliveredChannels: 1 });
        const request = await webhookServer.nextPayload();
        expect(request.headers['x-happier-signature-256']).toMatch(/^sha256=[a-f0-9]{64}$/);
        const payload = request.payload;
        expect(payload.topic).toBe(event.topic);
        if (payload.topic === 'workflow_run_update' || payload.topic === 'follow_update') {
          throw new Error(`Expected an ordinary ${event.topic} webhook payload`);
        }
        expect(payload.navigation).toEqual({ sessionId: event.sessionId, requestId: event.requestId });
        const details = event.topic === 'permission_request' ? [command, rationale] : questionDetails;
        if (requestIncludeMessageText !== false) {
          for (const detail of details) {
            expect(payload.content.body).toContain(detail);
            expect(payload.request?.toolDetails).toContain(detail);
          }
        } else {
          expect(payload.request?.toolDetails).toBeNull();
          for (const detail of details) expect(JSON.stringify(payload)).not.toContain(detail);
          expect(payload.content.body).toBe(event.topic === 'permission_request'
            ? 'Claude asks permission to use Bash'
            : 'Claude needs your input for AskUserQuestion');
        }
      }
    }
  }, 240_000);

  it('suppresses webhooks when canonical event policy disables an enabled legacy topic', async () => {
    const testDir = run.testDir(`notifications-webhook-canonical-toggle-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    webhookServer = await startActivityWebhookCaptureServer();

    const auth = await createTestAuth(server.baseUrl);
    await writeAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: buildCanonicalWebhookAccountSettings({
        webhookUrl: webhookServer.url,
        readyEventEnabled: false,
      }),
    });

    const { settings } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const dispatchResult = await dispatchActivityNotificationAsync({
      settings,
      nowMs: () => Date.parse('2026-05-03T12:00:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-ready-disabled',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
      },
    });
    expect(dispatchResult).toEqual({
      attemptedChannels: 0,
      deliveredChannels: 0,
    });
    await expect(webhookServer.nextPayload(250)).rejects.toThrow('Timed out waiting for webhook payload');
  }, 240_000);

  it('keeps webhooks delivering during quiet hours unless the webhook policy opts into suppression', async () => {
    const testDir = run.testDir(`notifications-webhook-quiet-hours-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    webhookServer = await startActivityWebhookCaptureServer();

    const auth = await createTestAuth(server.baseUrl);
    await writeAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: buildCanonicalWebhookAccountSettings({
        webhookUrl: webhookServer.url,
      }),
    });

    const { settings: settingsDuringQuietHours } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const deliveredDuringQuietHours = await dispatchActivityNotificationAsync({
      settings: settingsDuringQuietHours,
      nowMs: () => Date.parse('2026-05-03T23:30:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-quiet-deliver',
        sessionTitle: 'Night build',
        waitingForCommandLabel: 'Codex',
      },
    });
    expect(deliveredDuringQuietHours).toEqual({
      attemptedChannels: 1,
      deliveredChannels: 1,
    });
    const deliveredPayload = await webhookServer.nextPayload();
    expect(deliveredPayload.payload.topic).toBe('ready');
    expect(deliveredPayload.payload.navigation).toEqual({ sessionId: 'session-quiet-deliver' });

    await writeAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: buildCanonicalWebhookAccountSettings({
        webhookUrl: webhookServer.url,
        webhookQuietHoursBehavior: 'suppress',
      }),
    });

    const { settings: suppressingSettings } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const suppressedDuringQuietHours = await dispatchActivityNotificationAsync({
      settings: suppressingSettings,
      nowMs: () => Date.parse('2026-05-03T23:30:00.000Z'),
      event: {
        topic: 'ready',
        sessionId: 'session-quiet-suppress',
        sessionTitle: 'Night build',
        waitingForCommandLabel: 'Codex',
      },
    });
    expect(suppressedDuringQuietHours).toEqual({
      attemptedChannels: 0,
      deliveredChannels: 0,
    });
    await expect(webhookServer.nextPayload(250)).rejects.toThrow('Timed out waiting for webhook payload');
  }, 240_000);
});
