import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import type { ArtifactHeader, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { installApprovalCommonModuleMocks } from '../../approvals/approvalsTestHelpers';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APPROVAL_ARTIFACT_HEADER: ArtifactHeader = {
  title: 'Approve answering the user',
  actionId: 'session.user_action.answer',
  sessionId: 'session-1',
};

function createApprovalArtifact(): Extract<DecryptedArtifact, { isDecrypted: true }> {
  return { id: 'artifact-1', title: 'Approval', headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    isDecrypted: true, header: { ...APPROVAL_ARTIFACT_HEADER } };
}

installApprovalCommonModuleMocks();
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const initialState = storage.getState();
let serverIdB = '';
beforeEach(async () => {
  await upsertServerProfile({ serverUrl: 'https://home-b.example.test', name: 'Home B' });
  const profile = await setServerProfileIdentityForUrl('https://home-b.example.test', 'srv_approval_home_b');
  if (!profile) throw new Error('Expected the approval Home profile');
  serverIdB = profile.id;
  const primary = createSessionFixture({ id: 'session-1', metadata: {
    ...createSessionFixture().metadata!, name: 'Repo session', path: '/Users/leeroy/stale-repo',
    host: 'tester.local', homeDir: '/Users/leeroy', machineId: 'machine-stale',
  } });
  const secondary = createSessionFixture({ id: 'session-1', serverId: serverIdB, metadata: {
    ...createSessionFixture().metadata!, name: 'Secondary Home session', path: '/Users/secondary/repo',
    host: 'secondary.local', homeDir: '/Users/secondary', machineId: 'machine-secondary',
  } });
  storage.setState({ sessions: { [primary.id]: primary }, sessionListRowsByServerId: {
    [serverIdB]: { [secondary.id]: buildSessionListRenderableFromSession(secondary) },
  } });
});
afterEach(async () => {
  standardCleanup();
  storage.setState(initialState, true);
  if (serverIdB) await removeServerProfile(serverIdB);
});

describe('ApprovalInboxCard', () => {
  it('distinguishes an older saved-group approval by the name in its admitted body', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId: 'widgets.fragment.update', summary: 'Update saved group',
      actionArgs: { account: { serverId: serverIdB, accountId: 'owner' }, artifactId: 'opaque-library-id', patch: { name: 'Capacity and PRs' } },
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'rename-group',
        surface: 'cli', serverId: serverIdB, actionId: 'widgets.fragment.update' } });
    const artifact: DecryptedArtifact = { ...createApprovalArtifact(), header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const screen = await renderScreen(<ApprovalInboxCard artifact={artifact} onPress={() => {}} />);
    expect(screen.getTextContent()).toContain('Capacity and PRs');
    expect(screen.getTextContent()).not.toContain('opaque-library-id');
  });
  it('shows the qualified plugin action without interpreting it as a built-in action', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        title: 'Publish release notes',
        kind: 'target_action_approval.v1',
        qualifiedActionId: 'acme.publisher/actions/releases/publish',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    // A plugin action is named by its request, never by its raw qualified id.
    expect(screen.getTextContent()).toContain('Publish release notes');
    expect(screen.getTextContent()).not.toContain(
      'acme.publisher/actions/releases/publish',
    );
    expect(screen.getTextContent()).toContain('inbox.work.rows.approvalNeeded');
    expect(
      screen.findByTestId(`inbox.approval.${artifact.id}`)?.props,
    ).toMatchObject({
      accessibilityRole: 'button',
    });
    expect(
      String(
        screen.findByTestId(`inbox.approval.${artifact.id}`)?.props
          .accessibilityLabel,
      ),
    ).not.toContain('acme.publisher');
  });

  it('never repeats its title as the subtitle, and says what it needs instead', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        title: 'Respond to user-action request',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    const text = screen.getTextContent();
    expect(text.split('Respond to user-action request')).toHaveLength(2);
    // The session that asked tells this row from its siblings; "needs your approval" is not repeated.
    expect(text).toContain('Repo session');
    expect(text).not.toContain('inbox.work.rows.approvalNeeded');
    expect(
      String(
        screen.findByTestId(`inbox.approval.${artifact.id}`)?.props
          .accessibilityLabel,
      ),
    ).toContain('inbox.work.rows.approvalNeeded');
  });

  it('drops the raw session id an older request stored after its title', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        title: 'Set Session lead — cmv06zc2b003itmv4tsr5fin7',
        actionId: 'session.user_action.answer',
        sessionId: 'cmv06zc2b003itmv4tsr5fin7',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('Set Session lead');
    expect(text).not.toContain('cmv06zc2b003itmv4tsr5fin7');
    expect(
      String(
        screen.findByTestId(`inbox.approval.${artifact.id}`)?.props
          .accessibilityLabel,
      ),
    ).not.toContain('cmv06zc2b003itmv4tsr5fin7');
  });

  it('names an approval whose stored title is only its raw Action id by what it is', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        title: 'widgets.definition.update',
        actionId: 'widgets.definition.update',
        sessionId: 'session-1',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    // Titled by the Action's own name (or the plain fallback); the raw id is never copy.
    expect(screen.getTextContent()).not.toContain('widgets.definition.update');
    expect(
      String(screen.findByTestId(`inbox.approval.${artifact.id}`)?.props.accessibilityLabel ?? ''),
    ).not.toContain('widgets.definition.update');
  });

  it('says who asked on one line, without the machine, the folder or the Home address', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: { ...APPROVAL_ARTIFACT_HEADER, serverId: serverIdB },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard artifact={artifact} onPress={() => {}} />,
    );

    const text = screen.getTextContent();
    expect(text).toContain('Secondary Home session');
    expect(text).not.toContain('Secondary workstation');
    expect(text).not.toContain('repo');
    expect(text).not.toContain('home-b.example.test');
    // One Home: naming it on every row would only repeat it.
    expect(text).not.toContain('Home B');
    expect(
      screen.findHostByTestId(`inbox.approval.${artifact.id}.summary:facts`)?.props.numberOfLines,
    ).toBe(1);
  });

  it('names the Home when the Inbox spans several', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={
          {
            ...createApprovalArtifact(),
            header: { ...APPROVAL_ARTIFACT_HEADER, serverId: serverIdB },
          } satisfies DecryptedArtifact
        }
        onPress={() => {}}
        showHome
      />,
    );

    expect(screen.getTextContent()).toContain('Home B');
  });

  it('says where a session lives when this device does not have it, never its id', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        serverId: serverIdB,
        sessionId: 'cmv06zc2b003itmv4tsr5fin7',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard artifact={artifact} onPress={() => {}} />,
    );

    const text = screen.getTextContent();
    expect(text).toContain('detailPages.approval.sessionOnHome');
    expect(text).not.toContain('cmv06zc2b003itmv4tsr5fin7');
    expect(text).not.toContain('home-b.example.test');
    expect(text).not.toContain('inbox.work.rows.approvalNeeded');
  });

  it('uses the approval Home when another Home has the same Session id', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        serverId: serverIdB,
      },
    } satisfies DecryptedArtifact;

    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );

    expect(screen.getTextContent()).toContain('Secondary Home session');
    expect(screen.getTextContent()).not.toContain('Repo session');
    expect(screen.getTextContent()).not.toContain('/Users/secondary/repo');
  });

  it('finds the asking session through the Home identity when the request recorded another device’s Home id', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        // The asking device's own profile id for the Home, unknown on this device.
        serverId: 'creator-local-home',
        serverIdentityId: 'srv_approval_home_b',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );

    expect(screen.getTextContent()).toContain('Secondary Home session');
    expect(screen.getTextContent()).not.toContain(
      'inbox.work.rows.approvalNeeded',
    );
  });

  it('does not synthesize Home-wide freshness in approval context', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={
          {
            ...createApprovalArtifact(),
            header: { ...APPROVAL_ARTIFACT_HEADER, serverId: serverIdB },
          } satisfies DecryptedArtifact
        }
        onPress={() => {}}
        nowMs={1_081_000}
      />,
    );

    expect(screen.getTextContent()).not.toContain('Offline');
    expect(screen.getTextContent()).not.toContain('Last updated');
  });

  it('names a locked qualified Session by where it lives without exposing cached private metadata', async () => {
    const previous = storage.getState().sessionListRowsByServerId;
    const locked = createSessionFixture({
      id: 'session-1',
      serverId: serverIdB,
      encryptionMode: 'e2ee',
      encryptedContentAvailability: 'encrypted_access_pending',
      metadata: {
        name: 'Private cached Inbox title',
        path: '/Users/private/inbox-secret',
        host: 'secondary.local',
        homeDir: '/Users/private',
        machineId: 'machine-secondary',
      },
    });
    storage.setState({ sessionListRowsByServerId: { [serverIdB]: {
      [locked.id]: buildSessionListRenderableFromSession(locked),
    } } });
    try {
      const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
      const screen = await renderScreen(
        <ApprovalInboxCard
          artifact={
            {
              ...createApprovalArtifact(),
              header: { ...APPROVAL_ARTIFACT_HEADER, serverId: serverIdB },
            } satisfies DecryptedArtifact
          }
          onPress={() => {}}
        />,
      );

      expect(screen.getTextContent()).not.toContain(
        'Private cached Inbox title',
      );
      expect(screen.getTextContent()).not.toContain('inbox-secret');
      // A locked session reads by where it lives.
      expect(screen.getTextContent()).toContain('detailPages.approval.sessionOnHome');
    } finally {
      storage.setState({ sessionListRowsByServerId: previous });
    }
  });
});
