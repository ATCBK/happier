import { describe, expect, it } from 'vitest';
import { EntityDragItemV1Schema } from '@happier-dev/protocol/plugins/ui';
import { resolveWorkspaceDestinationEntityItem } from './workspaceEntitySource';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';

const scope = { serverId: 'home', accountId: 'account' };

describe('workspace entity sources', () => {
    it('preserves a repository directory identity without a navigation link', () => {
        const directory = { kind: 'repository-file', scope, machineId: 'machine', path: '/workspace/src', entryKind: 'directory' } as const;
        const item = resolveWorkspaceDestinationEntityItem({ href: null, scope, catalog: undefined, entityItem: directory });
        expect(item).toEqual(directory);
        expect(EntityDragItemV1Schema.safeParse(item).success).toBe(true);
    });
    it('carries a saved workflow through its registered destination identity', () => {
        const item = resolveWorkspaceDestinationEntityItem({ href: '/workflows/review', scope,
            catalog: resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: true, friends: false } }) });
        expect(item).toMatchObject({ kind: 'workflow', scope, workflowId: 'review' });
    });
});
