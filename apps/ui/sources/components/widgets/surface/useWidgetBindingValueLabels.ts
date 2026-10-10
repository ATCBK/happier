import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { isSameInputOptionValue } from '@happier-dev/protocol/inputs';
import { readWidgetInputTargetV1, type WidgetInputBindingsV1 } from '@happier-dev/protocol/widgets';

import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { describeWidgetBindingValue, readWidgetGroupInputCandidate } from '@/components/widgets/group/widgetGroupInputs';
import { storage, useSessionDisplayNameProjections, type SessionDisplayNameSource } from '@/sync/domains/state/storage';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { resolveWorkspaceDisplayPresentation } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { getSessionName } from '@/utils/sessions/sessionUtils';

export type WidgetBindingValueLabels = Readonly<Record<string, string | null>>;

const sessionName = (source: SessionDisplayNameSource | null) => source ? getSessionName(source, source.serverId) : null;

/** Live display words for declared pins; labels never become part of the stored binding. */
export function useWidgetBindingValueLabels(
    bindings: WidgetInputBindingsV1,
    candidate: Pick<WidgetCandidate, 'inputs' | 'sessionInputPath'> | null | undefined,
    fieldCandidates?: readonly (WidgetCandidate | null | undefined)[],
): WidgetBindingValueLabels {
    const entries = React.useMemo(() => {
        const fields = candidate?.inputs?.fields ?? [];
        const target = readWidgetInputTargetV1(candidate ?? {});
        const paths = fields.map(field => field.path);
        // Installed descriptors may declare their exact Session ABI without field hints.
        if (target.kind === 'session' && !paths.includes(target.path)) paths.unshift(target.path);
        return paths.map(path => {
            const field = fields.find(field => field.path === path);
            const binding = bindings[path];
            const value = binding?.kind === 'value' ? binding.value : undefined;
            const declaring = fieldCandidates ? readWidgetGroupInputCandidate(fieldCandidates, path) : undefined;
            const fieldTarget = declaring ? readWidgetInputTargetV1(declaring) : target;
            const session = value !== undefined && ((fieldTarget.kind === 'session' && fieldTarget.path === path)
                || (field?.inputType && 'hostType' in field.inputType && field.inputType.hostType === 'session'))
                ? VoiceTrackedSessionAddressV1Schema.safeParse(value) : null;
            const workspace = value !== undefined && field?.inputType && 'hostType' in field.inputType && field.inputType.hostType === 'workspace'
                ? WorkspaceRefV1Schema.safeParse(value) : null;
            return { path, field, value, session: session?.success ? session.data : null, workspace: workspace?.success ? workspace.data : null };
        });
    }, [bindings, candidate, fieldCandidates]);
    const addresses = React.useMemo(() => entries.flatMap(entry => entry.session ? [entry.session] : []), [entries]);
    const sessionNames = useSessionDisplayNameProjections(addresses, sessionName);
    // Select the displayed words only: unrelated workspace changes do not invalidate these pins.
    const workspaceNames = storage(useShallow(state => entries.map(entry => entry.workspace ? resolveWorkspaceDisplayPresentation({
        scope: entry.workspace, workspaceRefs: readProjectWorkspaceRefs(state), fallbackPathLabel: entry.workspace.rootPath,
        legacyLabel: entry.workspace.label,
    }).displayTitle : null)));
    return React.useMemo(() => {
        let sessionIndex = 0;
        return Object.fromEntries(entries.map((entry, index) => {
            const { field, value } = entry;
            let label: string | null = null;
            if (entry.session) label = sessionNames[sessionIndex++] ?? null;
            else if (entry.workspace) label = workspaceNames[index] ?? null;
            else if (value !== undefined && field) {
                const option = field.options?.find(option => isSameInputOptionValue(option.value, value));
                if (option) label = option.label;
                else if (!field.options && !field.optionsSourceId && !field.inputType) label = describeWidgetBindingValue(value);
            }
            return [entry.path, label];
        }));
    }, [entries, sessionNames, workspaceNames]);
}
