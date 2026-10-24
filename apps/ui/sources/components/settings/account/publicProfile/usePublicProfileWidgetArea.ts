import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { compileWidgetAreaPublicProfileLayoutV1, flattenWidgetLayoutWidgetsV1,
  WidgetDefinitionActionOutputSchemasV1, type BuiltinUsagePublicPresentationV1, type PublicProfileLayoutV1 } from '@happier-dev/protocol/widgets';
import { createPublicProfileWidgetAreaPresetsV1, type PublicProfileLayoutPresetIdV1 } from '@happier-dev/protocol/widgets/publicProfileWidgetPresetsV1';

import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAppShellPluginUiDeclarationSources } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useCorePageWidgetAreaBinding } from '@/components/widgets/area/useCorePageWidgetAreaBinding';
import { useWidgetAreaLayout, type WidgetAreaLayout, type WidgetAreaPort } from '@/components/widgets/area/useWidgetAreaLayout';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { storage } from '@/sync/domains/state/storage';

const EMPTY_CONTEXT: WidgetSurfaceContext = Object.freeze({});
const UNAVAILABLE_PORT: WidgetAreaPort = { execute: async () => ({ ok: false,
  errorCode: 'widget_area_scope_retired', error: 'widget_area_scope_retired' }) };

export type PublicProfileWidgetArea = Readonly<{
  binding: ReturnType<typeof useCorePageWidgetAreaBinding>;
  area: WidgetAreaLayout<WidgetSurfaceContext>;
  candidate: Readonly<{ layout: PublicProfileLayoutV1; isCurrent(): boolean }> | null;
  status: 'ready' | 'unavailable' | 'loading';
}>;

/** Private placement remains an Account Artifact; this is only its inert reviewed-copy adapter. */
export function usePublicProfileWidgetArea(serverId: string,
  execution: Pick<ReturnType<typeof useMountedActionExecution>, 'executeValue' | 'isCurrent'>,
  title?: (presentation: BuiltinUsagePublicPresentationV1) => string | undefined,
  /** The page's own context (its public period), so placed widgets read what the page covers. */
  context: WidgetSurfaceContext = EMPTY_CONTEXT,
  names?: Readonly<Record<PublicProfileLayoutPresetIdV1, string>>): PublicProfileWidgetArea {
  const presets = React.useMemo(() => createPublicProfileWidgetAreaPresetsV1({ title, ...(names ? { names } : {}) }), [title, names]);
  const binding = useCorePageWidgetAreaBinding({ serverId, pageId: 'public-profile', area: 'main', presets, context });
  const area = useWidgetAreaLayout(binding.port ?? UNAVAILABLE_PORT, context);
  const declarations = useAppShellPluginUiDeclarationSources();
  const state = area.state;
  const artifactIds = React.useMemo(() => state.status === 'ready'
    ? [...new Set(flattenWidgetLayoutWidgetsV1(state.items).flatMap(item => item.instance.definition.kind === 'artifact'
      ? [item.instance.definition.artifactId] : []))] : [], [state.status === 'ready' ? state.items : null]);
  // Definition edits invalidate only copies using those definitions, never every Account Artifact.
  const artifacts = storage(useShallow(store => artifactIds.map(id => store.artifacts[id] ?? null)));
  const source = React.useMemo(() => ({ state, surface: binding.surface, context, declarations, artifacts }), [state, binding.surface, context, declarations, artifacts]);
  const liveSource = React.useRef(source);
  liveSource.current = source;
  const execute = React.useRef(execution);
  execute.current = execution;
  const [compiled, setCompiled] = React.useState<Readonly<{ layout: PublicProfileLayoutV1; isCurrent(): boolean }> | null>(null);
  const [failure, setFailure] = React.useState<typeof source | null>(null);

  const isCurrent = React.useCallback((installedViews?: readonly PluginContributionIdentityV1[]) => {
    const current = liveSource.current;
    // A new observation is not a new reviewed layout. Compare its admitted
    // inputs, while authority and Artifact publications remain live guards.
    return execute.current.isCurrent() && source.state.status === 'ready' && current.state.status === 'ready'
      && current.state.isCurrent() && !current.state.readFailure && current.surface !== null
      && sameStrictJsonValue(current.state.surface.owner, current.surface.owner)
      && sameStrictJsonValue(current.surface, source.surface) && sameStrictJsonValue(current.context, source.context)
      && sameStrictJsonValue(current.state.surface, source.state.surface) && current.state.items === source.state.items
      && (current.declarations === source.declarations || installedViews !== undefined && installedViews.every(surface => {
        if (!source.declarations.accountLifetime?.isCurrent() || !current.declarations.accountLifetime?.isCurrent()) return false;
        const previous = readWidgetDescriptor(source.declarations.projection, surface);
        const next = readWidgetDescriptor(current.declarations.projection, surface);
        // The public compiler consumes only these installed-view fields, not
        // private inputs, provenance or unrelated declaration publications.
        return previous !== null && next !== null && previous.title === next.title
          && sameStrictJsonValue(previous.sizeDeclaration, next.sizeDeclaration)
          && sameStrictJsonValue(previous.publicPresentation, next.publicPresentation);
      })) && current.artifacts === source.artifacts
      && artifactIds.every((id, index) => (storage.getState().artifacts[id] ?? null) === artifacts[index]);
  }, [source, artifactIds, artifacts]);

  React.useEffect(() => {
    if (state.status !== 'ready' || !isCurrent() || compiled?.isCurrent()) return;
    let active = true;
    const controller = new AbortController();
    // Track the compiler's actual reads, including installed bodies reached
    // through Artifact definitions; builtins consume no plugin declarations.
    const installedViews: PluginContributionIdentityV1[] = [];
    const isPreparationCurrent = () => isCurrent(installedViews);
    void compileWidgetAreaPublicProfileLayoutV1({ v: 1, surface: state.surface, items: state.items }, {
      resolveDefinition: async reference => {
        if (!isPreparationCurrent()) return null;
        const result = await execute.current.executeValue('widgets.definition.get', {
          account: { serverId: state.surface.serverId, accountId: state.surface.accountId }, artifactId: reference.artifactId,
        }, { signal: controller.signal });
        return WidgetDefinitionActionOutputSchemasV1['widgets.definition.get'].parse(result).definition;
      },
      resolveInstalledView: surface => {
        installedViews.push(surface);
        return declarations.accountLifetime?.isCurrent() ? readWidgetDescriptor(declarations.projection, surface) : null;
      },
    }).then(layout => {
      if (active && isPreparationCurrent()) setCompiled({ layout, isCurrent: isPreparationCurrent });
    }).catch(() => { if (active && isPreparationCurrent()) setFailure(source); });
    return () => { active = false; controller.abort(); };
  }, [source, isCurrent, state, declarations, compiled]);

  const candidate = compiled?.isCurrent() ? { layout: compiled.layout, isCurrent: compiled.isCurrent } : null;
  const unavailable = state.status === 'unavailable' || state.status === 'ready' && Boolean(state.readFailure) || failure === source;
  return { binding, area, candidate, status: candidate ? 'ready' as const : unavailable ? 'unavailable' as const : 'loading' as const };
}
