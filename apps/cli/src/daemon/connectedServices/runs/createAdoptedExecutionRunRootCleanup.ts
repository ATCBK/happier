import { isAbsolute, relative, resolve } from 'node:path';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import { isConnectedServiceMaterializedHomeRetainedOnExit } from '../materialize/cleanup/createConnectedServiceMaterializedHomeCleanupScheduler';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { isCanonicalConnectedServiceMaterializedRoot } from '../materialize/privateMaterializedRoot';

export function createAdoptedExecutionRunRootCleanup(input: Readonly<{
    materializationBaseDir: string;
    materializedRoot: string;
    agentId: CatalogAgentId;
    materializationKey: string;
    removeRoot: (root: string) => Promise<void>;
}>): (() => Promise<void>) | null {
    const base = resolve(input.materializationBaseDir);
    const root = resolve(input.materializedRoot);
    const child = relative(base, root);
    if (!child || child.startsWith('..') || isAbsolute(child)) return null;
    const expectedRoot = resolve(resolveConnectedServiceMaterializedRootDir({
        baseDir: base,
        agentId: input.agentId,
        materializationKey: input.materializationKey,
    }));
    if (root !== expectedRoot) return null;
    return async () => {
        try {
            if (!await isCanonicalConnectedServiceMaterializedRoot({ baseDir: base, rootDir: root })) return;
        } catch {
            return;
        }
        if (!await isConnectedServiceMaterializedHomeRetainedOnExit({
            materializationKey: input.materializationKey, homeRoot: root,
        })) await input.removeRoot(root);
    };
}
