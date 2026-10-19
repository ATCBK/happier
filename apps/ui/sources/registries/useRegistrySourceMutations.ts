import * as React from 'react';
import type { z } from 'zod/mini';
import { REGISTRY_ACTION_INPUT_SCHEMAS_V1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

export function useRegistrySourceMutations() {
    const scope = useAccountSettingsScope();
    const execution = useMountedActionExecution(scope);
    const execute = React.useCallback(async <K extends 'registries.sources.detect' | 'registries.sources.create' | 'registries.sources.update' | 'registries.sources.token.set' | 'registries.sources.delete'>(
        actionId: K, input: z.infer<(typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1)[K]>): Promise<z.infer<(typeof REGISTRY_ACTION_OUTPUT_SCHEMAS_V1)[K]>> => {
        const result = await execution.execute(actionId, input);
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode, result });
        // The schema indexed by this same Action id validates the correlated result.
        return REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result.result) as z.infer<(typeof REGISTRY_ACTION_OUTPUT_SCHEMAS_V1)[K]>;
    }, [execution.execute]);
    return React.useMemo(() => ({ ready: execution.ready, execute,
        detect: (input: z.infer<typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.detect']>) => execute('registries.sources.detect', input),
        create: (input: z.infer<typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.create']>) => execute('registries.sources.create', input),
        update: (input: z.infer<typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.update']>) => execute('registries.sources.update', input),
        setToken: (input: z.infer<typeof REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.sources.token.set']>) => execute('registries.sources.token.set', input),
        delete: (sourceId: string) => execute('registries.sources.delete', { sourceId }),
    }), [execute, execution.ready]);
}
