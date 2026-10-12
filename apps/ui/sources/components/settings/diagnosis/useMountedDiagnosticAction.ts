import * as React from 'react';
import type { DiagnosticsActionId, DiagnosticsActionResult } from '@happier-dev/protocol/actions/diagnosticsActionFamily';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { registerMountedDiagnosticOwner, type DiagnosticInvocation } from './diagnosticsActionRuntime';

export function useMountedDiagnosticAction(actionId: DiagnosticsActionId, execution: ReturnType<typeof useMountedActionExecution>,
    run: (request: DiagnosticInvocation) => Promise<DiagnosticsActionResult>) {
    const [running, setRunning] = React.useState(false);
    const runRef = React.useRef(run);
    runRef.current = run;
    const lifetime = React.useMemo(() => ({ active: true, pending: 0 }), [execution.binding]);
    React.useEffect(() => {
        lifetime.active = true;
        setRunning(false);
        const retirement = execution.binding?.onRetire(() => {
            lifetime.active = false;
            setRunning(false);
        });
        return () => { retirement?.dispose(); lifetime.active = false; };
    }, [execution.binding, lifetime]);
    React.useEffect(() => {
        if (!execution.binding) return;
        return registerMountedDiagnosticOwner(actionId, {
            scope: execution.binding.scope,
            isCurrent: () => lifetime.active && execution.isCurrent(),
            run: async request => {
                lifetime.pending += 1;
                setRunning(true);
                try { return await runRef.current(request); }
                finally {
                    lifetime.pending -= 1;
                    if (lifetime.active) setRunning(lifetime.pending > 0);
                }
            },
        });
    }, [actionId, execution.binding, execution.isCurrent, lifetime]);
    return running;
}
