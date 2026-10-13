import { describe, expect, expectTypeOf, it } from 'vitest';

import type { SessionServerStartSpawnDraftV1 as ProtocolServerStartDraft } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import {
    SessionServerStartSpawnDraftV1Schema,
    type SessionServerStartSpawnDraftV1,
} from '../sessions/index.js';

describe('SDK server-start author draft', () => {
    it('agrees with the canonical draft and refuses caller-owned birth facts', () => {
        expectTypeOf<keyof SessionServerStartSpawnDraftV1>().toEqualTypeOf<keyof ProtocolServerStartDraft>();
        const draft = {
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/workspace' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        } as const satisfies SessionServerStartSpawnDraftV1;
        expect(SessionServerStartSpawnDraftV1Schema.parse(draft)).toEqual(draft);
        for (const excluded of [
            { creationKey: 'author-key' },
            { initialInput: { text: 'hello' } },
            { environmentVariables: { SECRET: 'value' } },
            { attestedContext: { externalPrincipalId: 'forged', sourceMessageId: '<forged>' } },
        ]) {
            expect(SessionServerStartSpawnDraftV1Schema.safeParse({ ...draft, ...excluded }).success).toBe(false);
        }
    });
});
