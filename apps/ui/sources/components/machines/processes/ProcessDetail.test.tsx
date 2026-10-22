import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

import { ProcessDetail } from './ProcessDetail';
import { processRow } from './testkit/processesAnswerFixture';
import { ProcessOwnerMark } from './processOwnerIdentity';
import { MachineAgentMark } from '@/components/machines/agents/MachineAgentMark';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getStorage } from '@/sync/domains/state/storage';

afterEach(standardCleanup);

async function mountDetail(row: ReturnType<typeof processRow>) {
  return renderScreen(
    <ListPresentationProvider value="page">
      <ProcessDetail
        row={row}
        owner={null}
        ownerTitle="Happier"
        machineName="leeroy-mbp"
        platform="linux"
        samples={undefined}
        onCopyCommand={null}
        onOpenSession={null}
      />
    </ListPresentationProvider>,
  );
}

describe('ProcessDetail', () => {
  it.each(['codex', 'acme.agent', null])('marks a Session process with public Agent %s instead of owner-only identity', async agentId => {
    const initial = getStorage().getState();
    const session = createSessionFixture({ id: 'process-agent', serverId: 'home', metadataLayoutVersion: 1,
      metadata: { v: 1, ...(agentId ? { agentPresentation: { agentId } } : {}) } as never,
      ownerMetadataView: { path: '/private', host: 'home', flavor: 'claude' } });
    getStorage().setState({ sessions: { [session.id]: session } });
    try {
      const screen = await renderScreen(<ProcessOwnerMark owner={{ kind: 'session', sessionId: session.id }} serverId="home" machineId="machine" />);
      const markType = 'type' in MachineAgentMark ? MachineAgentMark.type : MachineAgentMark;
      expect(screen.tree.root.findAll(node => node.type === markType).map(node => node.props.agentId)).toEqual(agentId ? [agentId] : []);
      await screen.unmount();
    } finally { getStorage().setState(initial, true); }
  });

  it('names the process once at the end of its started-by chain, though the daemon chain ends with the process itself', async () => {
    const row = processRow('main', 'owner', {
      name: 'MainThread',
      pid: 500,
      chain: [
        { pid: 400, name: 'launcher' },
        { pid: 500, name: 'MainThread' },
      ],
      evidence: [{ kind: 'marker', state: 'met', reason: 'marker_matches' }],
    });
    const screen = await mountDetail(row);
    expect(screen.getTextContent()).toContain('Started by Happier launcher MainThread How Happier knows');
    expect(screen.getTextContent()).not.toContain('MainThread MainThread');
  });

  it('says the evidence is loading until the detail read delivers it, never an evidence section with only its footnote', async () => {
    const waiting = await mountDetail(processRow('main', 'owner', { name: 'MainThread' }));
    expect(waiting.findByTestId('machine-processes-evidence-loading')).not.toBeNull();
    const arrived = await mountDetail(
      processRow('main', 'owner', {
        name: 'MainThread',
        evidence: [{ kind: 'marker', state: 'met', reason: 'marker_matches' }],
      }),
    );
    expect(arrived.findByTestId('machine-processes-evidence-loading')).toBeNull();
    expect(arrived.findByTestId('machine-processes-evidence-marker-met')).not.toBeNull();
  });
});
