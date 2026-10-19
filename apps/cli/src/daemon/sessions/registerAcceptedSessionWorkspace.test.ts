import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { mutateProjectAccountOrganization, getActiveProjectAccountRowsSnapshot, createProjectAccountSnapshotMutation } from '@/workspaces/projectAccountRows';
import { materializeWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from '@/scm/registry';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest, runWithRealGitScmRuntime } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { githubHostingProviderAdapter, GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID } from '../../../../../packages/plugins/scm-github/src/adapter';
import { GITHUB_PLUGIN_ID } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { createAcceptedSessionWorkspaceRegistration } from './registerAcceptedSessionWorkspace';

const execFileAsync = promisify(execFile);
afterEach(() => vi.restoreAllMocks());

describe('accepted Session workspace registration', () => {
  it('registers true SCM roots and joins only a unique proven hosting anchor without resurrecting Hide', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'happier-accepted-workspace-'));
    const root = await realpath(scratch);
    const directory = join(root, 'packages', 'app');
    await mkdir(directory, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/Owner/Repository.git'], { cwd: root });
    const other = { id: 'other-home-ref', serverId: 'home-b', machineId: 'machine-a', rootPath: root, createdAtMs: 1 };
    const otherKey = { kind: 'workspace-ref' as const, serverId: 'home-b', id: other.id };
    const organizationKey = { kind: 'project-organization' as const, serverId: 'srv_rf10_home', projectKey: 'hidden-project' };
    const organization: ProjectAccountRowV1 = { key: organizationKey, revision: 2, content: { t: 'plain', v: { key: organizationKey, value: { hidden: true, pinned: true } } } };
    const rows: ProjectAccountRowV1[] = [{ key: otherKey, revision: 0, content: { t: 'plain', v: { key: otherKey, value: other } } }, organization];
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    env.patch({ HAPPIER_HOME_DIR: join(root, 'cli-home'), HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
    reloadConfiguration();
    const profile = await addServerProfile({ name: 'daemon-local', serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test', use: true });
    await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
      v: 1, homeServerIdentityId: 'srv_rf10_home', canonicalServerUrl: profile.serverUrl, revision: 1,
      endpoints: [{ kind: 'https', url: profile.serverUrl }],
    } });
    const requesterKey = { kind: 'workspace-ref' as const, serverId: 'srv_rf10_home', id: 'requester-anchor' };
    const requesterRef = { id: requesterKey.id, serverId: 'srv_rf10_home', machineId: 'machine-a', rootPath: root, createdAtMs: 1 };
    const requesterOrganizationKey = { kind: 'project-organization' as const, serverId: 'srv_rf10_home', projectKey: requesterKey.id };
    const requesterOrganization: ProjectAccountRowV1 = { key: requesterOrganizationKey, revision: 4,
      content: { t: 'plain', v: { key: requesterOrganizationKey, value: { hidden: true, pinned: true } } } };
    const requesterRows: ProjectAccountRowV1[] = [{ key: requesterKey, revision: 0,
      content: { t: 'plain', v: { key: requesterKey, value: requesterRef } } }, requesterOrganization];
    let requesterCurrent = true;
    let requesterSessionId = 'accepted-session';
    let requesterAvailable = false;
    let revokeRequesterOnList = false;
    const requester = { credentials: { token: 'requester-token', encryption: null }, serverHttpBaseUrl: profile.serverUrl,
      attribution: { serverId: profile.id, accountId: 'requester', machineId: 'machine-a', installationId: 'installation' },
      getBoundSessionId: () => requesterSessionId, isCurrent: async () => requesterCurrent, release: async () => {} };
    let ownerProjection: 'owner' | 'recipient' | 'missing' = 'owner';
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      const requesterRead = config?.headers?.Authorization === 'Bearer requester-token';
      const session = createSessionRecordFixture({ id: 'accepted-session', encryptionMode: 'plain',
        ...(requesterRead || ownerProjection === 'owner' ? { share: null } : ownerProjection === 'recipient' ? {
          share: { accessLevel: 'edit', canApprovePermissions: false },
        } : {}),
      });
      return { status: 200, data: { session } };
    });
    const requests: ReturnType<typeof ProjectAccountRowMutationRequestV1Schema.parse>[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const accountRows = config?.headers?.Authorization === 'Bearer requester-token' ? requesterRows : rows;
      if (url.endsWith('/list')) {
        if (accountRows === requesterRows && revokeRequesterOnList) requesterCurrent = false;
        return { status: 200, data: { status: 'listed', coverage: 'complete', rows: accountRows } };
      }
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      requests.push(request);
      const acknowledged: ProjectAccountRowV1[] = [];
      for (const mutation of request.mutations) {
        const index = accountRows.findIndex(row => JSON.stringify(row.key) === JSON.stringify(mutation.key));
        const row = { key: mutation.key, revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content };
        if (index < 0) accountRows.push(row); else accountRows[index] = row;
        acknowledged.push(row);
      }
      // The canonical mutate response acknowledges only this batch, never the whole list census.
      return { status: 200, data: { status: 'updated', rows: acknowledged, cursor: 1 } };
    });
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime) throw new Error('Git SCM test runtime is unavailable');
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime, registration,
    })]);
    const hostingProviderRuntimeServices = createScmHostingProviderRuntimeServicesForTest(createScmHostingProviderRegistry({
      providers: [{ id: GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID, pluginId: GITHUB_PLUGIN_ID, kind: 'github', displayName: 'GitHub', capabilities: [] }],
      runtimeRegistrations: [{ pluginId: GITHUB_PLUGIN_ID, occurrenceId: 'test-generation',
        registration: { id: GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID, adapter: { routing: githubHostingProviderAdapter } } }],
    }));
    const inspectLocation: typeof inspectWorkspaceLocationWithScmWorkspace = input => runWithRealGitScmRuntime(
      () => inspectWorkspaceLocationWithScmWorkspace({ ...input, registry }), { hostingProviderRuntimeServices },
    );
    const register = createAcceptedSessionWorkspaceRegistration({
      credentials: { token: 'project-token', encryption: null }, serverId: profile.id, machineId: 'machine-a',
      inspectLocation,
      requesterSessionCustody: { resolve: async () => requesterAvailable ? requester : null },
    });
    const metadata = createTestMetadata({ path: directory });
    try {
      ownerProjection = 'recipient';
      await expect(register(metadata, 'accepted-session')).rejects.toMatchObject({ code: 'workspace_registration_requester_channel_unavailable' });
      ownerProjection = 'missing';
      await expect(register(metadata, 'accepted-session')).rejects.toMatchObject({ code: 'workspace_registration_owner_unavailable' });
      expect(requests).toHaveLength(0);
      ownerProjection = 'owner';
      await register({ ...metadata, sessionDirectoryV1: { v: 1, kind: 'managed' } }, 'accepted-session');
      expect(requests).toHaveLength(0);
      await register(metadata, 'accepted-session');
      const accepted = rows.flatMap(row => row.content?.t === 'plain' && row.content.v.key.kind === 'workspace-ref'
        && 'id' in row.content.v.value && row.content.v.value.serverId === 'srv_rf10_home' ? [row.content.v.value] : []);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ rootPath: root, serverId: 'srv_rf10_home', machineId: 'machine-a' });
      expect(accepted[0]?.repositoryIdentity).toEqual({ kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' });
      // The real accepted-root owner used by Open, on a client without this profile alias,
      // must reuse the daemon's row rather than assigning a second anchor.
      const reopened = materializeWorkspaceRefForMachineRoot(accepted, { serverId: 'srv_rf10_home', machineId: 'machine-a',
        rootPath: root, nowMs: 2, createId: () => 'incorrect-second-anchor' });
      expect(reopened).toMatchObject({ created: false, workspaceRef: { id: accepted[0]!.id, serverId: 'srv_rf10_home' } });
      expect(projectProjectListV1({ serverId: 'srv_rf10_home', workspaceRefs: accepted }).items)
        .toMatchObject([{ workspaceAddress: { serverId: 'srv_rf10_home', workspaceId: accepted[0]!.id, rootPath: root } }]);
      expect(projectWorkspaceRefV1(accepted[0]!)).toEqual({ serverId: 'srv_rf10_home', projectKey: accepted[0]!.id });
      expect(metadata.path).toBe(directory);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.topologyChange).toBe(true);
      const project = projectWorkspaceRefV1(accepted[0]!);
      await mutateProjectAccountOrganization({
        credentials: { token: 'project-token', encryption: null }, ...project,
        mutate: value => ({ ...value, hidden: true, pinned: true }),
      });
      const acceptedOrganization = rows.find(row => row.key.kind === 'project-organization'
        && row.key.serverId === project.serverId && row.key.projectKey === project.projectKey);
      expect(acceptedOrganization?.content).toEqual({ t: 'plain', v: {
        key: { kind: 'project-organization', ...project }, value: { hidden: true, pinned: true },
      } });
      await register(metadata, 'accepted-session');
      expect(requests).toHaveLength(2);
      expect(rows.find(row => row.key.kind === 'project-organization'
        && row.key.serverId === project.serverId && row.key.projectKey === project.projectKey))
        .toEqual(acceptedOrganization);
      expect(rows.find(row => row.key.kind === 'project-organization' && row.key.projectKey === 'hidden-project')).toEqual(organization);
      expect(rows.find(row => row.key.kind === 'workspace-ref' && row.key.serverId === 'home-b')?.content)
        .toEqual({ t: 'plain', v: { key: otherKey, value: other } });
      await register(createTestMetadata({ path: tmpdir() }), 'accepted-session');
      expect(requests).toHaveLength(2);

      const registerElsewhere = createAcceptedSessionWorkspaceRegistration({
        credentials: { token: 'project-token', encryption: null }, serverId: profile.id, machineId: 'machine-b', inspectLocation,
      });
      const checkout = async (name: string, remote?: string) => {
        const checkoutRoot = join(root, name);
        await mkdir(join(checkoutRoot, 'nested'), { recursive: true });
        await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: checkoutRoot });
        if (remote) await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: checkoutRoot });
        return checkoutRoot;
      };
      const refAt = (checkoutRoot: string) => rows.flatMap(row => row.content?.t === 'plain'
        && row.content.v.key.kind === 'workspace-ref' && 'id' in row.content.v.value
        && row.content.v.value.serverId === 'srv_rf10_home' && row.content.v.value.rootPath === checkoutRoot ? [row.content.v.value] : [])[0];
      const secondRoot = await checkout('second', 'git@github.com:owner/repository.git');
      await registerElsewhere(createTestMetadata({ path: join(secondRoot, 'nested') }), 'accepted-session');
      expect(refAt(secondRoot)).toMatchObject({ machineId: 'machine-b', rootPath: secondRoot, projectKey: project.projectKey,
        repositoryIdentity: accepted[0]?.repositoryIdentity });
      expect(rows.find(row => row.key.kind === 'project-organization'
        && row.key.serverId === project.serverId && row.key.projectKey === project.projectKey)).toEqual(acceptedOrganization);

      const unknownRoot = await checkout('unknown');
      await registerElsewhere(createTestMetadata({ path: unknownRoot }), 'accepted-session');
      const unknown = refAt(unknownRoot)!;
      expect(unknown.projectKey).toBe(unknown.id);
      expect(unknown.projectKey).not.toBe(project.projectKey);
      expect(unknown.repositoryIdentity).toBeUndefined();
      await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repository.git'], { cwd: unknownRoot });
      await registerElsewhere(createTestMetadata({ path: unknownRoot }), 'accepted-session');
      expect(refAt(unknownRoot)).toMatchObject({ projectKey: unknown.id, repositoryIdentity: accepted[0]?.repositoryIdentity });
      const ambiguousRoot = await checkout('ambiguous', 'https://github.com/owner/repository.git');
      const beforeAmbiguous = requests.length;
      await registerElsewhere(createTestMetadata({ path: ambiguousRoot }), 'accepted-session');
      const independent = refAt(ambiguousRoot)!;
      expect(independent).toMatchObject({ machineId: 'machine-b', rootPath: ambiguousRoot,
        projectKey: independent.id, repositoryIdentity: accepted[0]?.repositoryIdentity });
      expect(independent.projectKey).not.toBe(project.projectKey);
      expect(independent.projectKey).not.toBe(unknown.projectKey);
      expect(refAt(secondRoot)?.projectKey).toBe(project.projectKey);
      expect(refAt(unknownRoot)?.projectKey).toBe(unknown.projectKey);
      expect(rows.find(row => row.key.kind === 'project-organization'
        && row.key.serverId === project.serverId && row.key.projectKey === project.projectKey)).toEqual(acceptedOrganization);
      expect(rows.find(row => row.key.kind === 'project-organization' && row.key.projectKey === 'hidden-project')).toEqual(organization);
      expect(requests).toHaveLength(beforeAmbiguous + 1);

      const custodianRows = structuredClone(rows);
      const daemonSnapshot = getActiveProjectAccountRowsSnapshot();
      ownerProjection = 'recipient';
      requesterAvailable = true;
      await register(metadata, 'accepted-session');
      expect(requesterRows.find(row => row.key.kind === 'workspace-ref')?.content).toMatchObject({ t: 'plain', v: {
        value: { ...requesterRef, repositoryIdentity: accepted[0]?.repositoryIdentity },
      } });
      expect(requesterRows.find(row => row.key.kind === 'project-organization')).toEqual(requesterOrganization);
      expect(rows).toEqual(custodianRows);
      expect(getActiveProjectAccountRowsSnapshot()).toBe(daemonSnapshot);
      ownerProjection = 'missing';
      // The custodian need not be permitted to read this private Session at all.
      await register(metadata, 'accepted-session');
      expect(rows).toEqual(custodianRows);
      const beforeRefusal = requests.length;
      requesterCurrent = false;
      await expect(register(metadata, 'accepted-session')).rejects.toMatchObject({ code: 'workspace_registration_requester_channel_unavailable' });
      requesterCurrent = true;
      requesterSessionId = 'another-session';
      await expect(register(metadata, 'accepted-session')).rejects.toMatchObject({ code: 'workspace_registration_requester_channel_unavailable' });
      requesterSessionId = 'accepted-session';
      for (const field of ['serverId', 'machineId'] as const) {
        const original = requester.attribution[field];
        requester.attribution[field] = 'wrong-target';
        await expect(register(metadata, 'accepted-session')).rejects.toMatchObject({ code: 'workspace_registration_requester_channel_unavailable' });
        requester.attribution[field] = original;
      }
      revokeRequesterOnList = true;
      await expect(register(metadata, 'accepted-session')).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
      revokeRequesterOnList = false;
      requesterCurrent = true;
      expect(requests).toHaveLength(beforeRefusal);
      expect(rows).toEqual(custodianRows);
      expect(getActiveProjectAccountRowsSnapshot()).toBe(daemonSnapshot);
      ownerProjection = 'owner';
      requesterAvailable = false;
      await expect(createAcceptedSessionWorkspaceRegistration({ credentials: { token: 'project-token', encryption: null },
        serverId: 'unbound-profile', machineId: 'machine-a', inspectLocation })(metadata, 'accepted-session'))
        .rejects.toMatchObject({ code: 'workspace_registration_home_unavailable' });
      const legacyKey = { kind: 'workspace-ref' as const, serverId: profile.id, id: 'retained-local-anchor' };
      const legacyRoot = await checkout('retained-local');
      rows.push({ key: legacyKey, revision: 3, content: { t: 'plain', v: { key: legacyKey,
        value: { id: legacyKey.id, serverId: profile.id, machineId: 'machine-a', rootPath: legacyRoot, createdAtMs: 1 } } } });
      const retained = structuredClone(rows);
      await expect(register(createTestMetadata({ path: legacyRoot }), 'accepted-session')).rejects.toMatchObject({ code: 'project_home_reconciliation_required' });
      expect(rows).toEqual(retained);
      expect(requests).toHaveLength(beforeRefusal);
      await expect(createProjectAccountSnapshotMutation({ credentials: { token: 'project-token', encryption: null }, serverId: profile.id })(snapshot => ({
        ...snapshot, workspaceRefs: snapshot.workspaceRefs.map(ref => ref.id === legacyKey.id ? { ...ref, label: 'Retained checkout' } : ref),
      }))).resolves.toMatchObject({ status: 'applied' });
      expect(rows.find(row => row.key.kind === 'workspace-ref' && row.key.id === legacyKey.id)?.content)
        .toMatchObject({ t: 'plain', v: { value: { id: legacyKey.id, serverId: profile.id, rootPath: legacyRoot, label: 'Retained checkout' } } });
      const unrelatedRoot = await checkout('unrelated-new');
      await register(createTestMetadata({ path: unrelatedRoot }), 'accepted-session');
      expect(refAt(unrelatedRoot)).toMatchObject({ serverId: 'srv_rf10_home', rootPath: unrelatedRoot });
    } finally {
      env.restore();
      reloadConfiguration();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
