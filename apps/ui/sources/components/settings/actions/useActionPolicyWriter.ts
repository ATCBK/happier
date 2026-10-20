import * as React from 'react';
import type { ActionPolicySetInput } from '@happier-dev/protocol/actions/actionPolicyActionFamily';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { getStorage } from '@/sync/domains/state/storageStore';

/** Submit one policy intent; mounted Action admission owns the Account and approval lifetime. */
export function useActionPolicyWriter() {
    const scope = getStorage()(state => state.settingsScope);
    const { execute } = useMountedActionExecution(scope, { openOnRequest: true });
    return React.useCallback((input: ActionPolicySetInput) => execute('actions.policy.set', input), [execute]);
}
