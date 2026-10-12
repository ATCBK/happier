import { expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { EMPTY_PROJECT_AUTHORING_SESSION_INPUTS, updateProjectAuthoringSessionInputs } from './projectAuthoringSessions';

it('keeps ordinary Scripts-origin sessions out of setup-authoring provenance and removes a reclassified entry', () => {
    const origin = { kind: 'project', accountId: 'account-a', page: 'scripts',
        workspace: { serverId: 'home-a', workspaceId: 'checkout-a', machineId: 'machine-a', rootPath: '/repo' } } as const;
    const session = createSessionFixture({ id: 'author', updatedAt: 10, metadata: {
        machineId: 'machine-a', path: '/repo', host: 'machine', work: { authoringOriginV1: origin },
    } });
    const setup = updateProjectAuthoringSessionInputs(EMPTY_PROJECT_AUTHORING_SESSION_INPUTS, session.id, session);
    expect(setup[session.id]?.sessionId).toBe(session.id);
    const ordinary = { ...session, metadata: { ...session.metadata!,
        work: { authoringOriginV1: { ...origin, purpose: 'session' as const } },
    } };
    expect(updateProjectAuthoringSessionInputs(EMPTY_PROJECT_AUTHORING_SESSION_INPUTS, ordinary.id, ordinary))
        .toBe(EMPTY_PROJECT_AUTHORING_SESSION_INPUTS);
    expect(updateProjectAuthoringSessionInputs(setup, ordinary.id, ordinary)).toEqual({});
});
