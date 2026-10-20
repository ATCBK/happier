import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createCliActionDeps } from './createCliActionDeps';
import { createCounterWidgetFixture } from './widgetApproval.testkit';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/**
 * A Session picked from the `sessions` options source must be admitted by the same Home decision that
 * the widget validator applies: a device-local profile id plus the Home's portable identity.
 */
describe('CLI widget Session input scope', () => {
  const home = 'https://widget-session-home.test';
  const sessionId = 'c111111111111111111111111';
  const homeIdentity = 'srv_widget_session_home';
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'viewer' })).toString('base64url')}.signature`;

  it('admits the Session the options resolver offers for the portable Home identity', async () => {
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 1, share: null,
      dataEncryptionKey: null, metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { path: '/repo', host: 'host', machineId: 'machine' } }) });
    // Only Home HTTP is substituted; Action dispatch, scope admission and the widget input owner stay real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = String(url);
      if (path.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
      if (path.endsWith('/v2/account/settings')) return { status: 200, data: AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }) };
      // The Home layout Artifact does not exist yet: a definite absence, not a failure.
      if (path.includes('/v1/artifacts/')) return { status: 404, data: { error: 'not_found' } };
      throw new Error(`Unexpected Home read: ${url}`);
    });
    // Machine RPC is the process boundary that serves the Machine's plugin projection; Built-in widgets stay host-owned.
    vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ protocolVersion: 1, projection: createCounterWidgetFixture().projection });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId, mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: homeIdentity, serverHttpBaseUrl: home });
    const picked = { serverId: homeIdentity, sessionId };
    const resolved = await deps.widgetInputs!.resolve({
      ref: { surface: { serverId: homeIdentity, accountId: 'viewer', owner: { kind: 'home' } }, instanceId: 'summary' },
      instance: { v: 1, id: 'summary', definition: { kind: 'builtin', id: 'session_summary' }, bindings: { session: { kind: 'value', value: picked } } },
      context: { surface: 'cli', authority: 'present_user', serverId: homeIdentity, serverIdentityId: homeIdentity },
    });
    expect(resolved, JSON.stringify(resolved)).toEqual({ status: 'ready', input: { session: picked } });
  });
});
