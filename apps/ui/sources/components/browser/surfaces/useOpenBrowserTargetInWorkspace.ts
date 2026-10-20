import * as React from 'react';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useDesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/useDesktopWebViewNativeAvailability';
import { registerBrowserRuntimeWorkspaceOpeningAdapter } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { usePaneRegion } from '@/components/appShell/panes/paneRegion';
import { createOpenBrowserTargetInWorkspace, type CreateOpenBrowserTargetInWorkspaceDeps } from './openBrowserTargetInWorkspace';

/** Workspace presentation lifetime exists before any Browser view is rendered. */
export function useOpenBrowserTargetInWorkspace(deps: CreateOpenBrowserTargetInWorkspaceDeps) {
    const browserFeatureDecision = useFeatureDecision('browser', deps.accountLifetime
        ? { scopeKind: 'spawn', serverId: deps.accountLifetime.scope.serverId }
        : { scopeKind: 'runtime' });
    const desktopWebViewAvailability = useDesktopWebViewNativeAvailability({
        platform: deps.platform, availability: deps.desktopWebViewAvailability,
    });
    const paneRegion = usePaneRegion();
    const openerRegion = React.useRef(paneRegion);
    openerRegion.current = paneRegion;
    const facts = React.useRef(deps);
    facts.current = { ...deps, browserFeatureDecision: deps.browserFeatureDecision ?? browserFeatureDecision,
        desktopWebViewAvailability };
    const binding = React.useMemo(() => {
        const lifetime = { current: true, controller: new AbortController() };
        const open = createOpenBrowserTargetInWorkspace({ ...deps,
            get signal() { return lifetime.controller.signal; },
            readOpenFacts: () => facts.current,
            readOpenerRegion: () => (openerRegion.current === 'main' || openerRegion.current === 'side' ? openerRegion.current : null),
            isCurrent: () => lifetime.current && facts.current.accountLifetime === deps.accountLifetime
                && facts.current.scopeId === deps.scopeId && facts.current.scope === deps.scope
                && facts.current.openDetailsTab === deps.openDetailsTab,
        });
        return { open, lifetime };
    }, [deps.scopeId, deps.scope, deps.accountLifetime, deps.openDetailsTab]);
    React.useEffect(() => {
        binding.lifetime.current = true;
        if (binding.lifetime.controller.signal.aborted) binding.lifetime.controller = new AbortController();
        const unregister = registerBrowserRuntimeWorkspaceOpeningAdapter(binding.open.runtimeAdapter);
        return () => { binding.lifetime.current = false; binding.lifetime.controller.abort(); unregister(); };
    }, [binding]);
    return binding.open;
}
