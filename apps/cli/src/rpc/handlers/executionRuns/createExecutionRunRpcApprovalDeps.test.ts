import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { GENERAL_PLUGIN_PERMISSION_SUBJECT_V1 } from '@happier-dev/protocol/plugins/permissions/grants';
import { REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1 } from '@happier-dev/protocol/reviews/comments/v1';
import { reloadConfiguration } from '@/configuration';
import { createRunnerReviewHostPluginAuthorityReader } from '@/agent/executionRuns/profiles/review/pluginAuthority';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createExecutionRunRpcApprovalDeps } from './createExecutionRunRpcApprovalDeps';

it('refuses caller-supplied grant provenance when the runner has no current daemon authority', async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-review-grant-provenance-'));
  vi.stubEnv('HAPPIER_HOME_DIR', home);
  vi.stubEnv(HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY, '');
  reloadConfiguration();
  // HTTP is the only substituted boundary; caller resolution and publisher
  // admission are real and use an empty isolated Machine home.
  const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('unexpected_grant_effect'));
  try {
    const deps = createExecutionRunRpcApprovalDeps({ readCredentials: async () => ({ token: 'test-token', encryption: null }),
      resolveReviewHostPluginAuthority: createRunnerReviewHostPluginAuthorityReader('session-1') });
    await expect(deps.pluginPermissionGrantRequest!({ pluginId: 'acme.review',
      capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1, targetScope: { kind: 'project', projectId: 'project-1' },
      subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
      requester: { kind: 'plugin', pluginId: 'acme.review', sessionId: 'session-1', requestId: 'call-1' },
      reason: 'Write approved review comments directly.',
      caller: { pluginId: 'acme.review', machineId: 'forged-machine', materializationId: 'forged-materialization' },
    })).rejects.toThrow('plugin_permission_grant_publisher_proof_required');
    expect(post).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration();
    await rm(home, { recursive: true, force: true });
  }
});
