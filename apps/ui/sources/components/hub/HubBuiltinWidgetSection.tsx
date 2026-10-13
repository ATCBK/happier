import * as React from 'react';
import { useOptionalPluginUiScrollActivityTracker } from '@happier-dev/plugin-ui/advanced';
import {
    proposeWidgetInputDefaultBindingsV1,
    readBuiltinWidgetDescriptorV1,
    type WidgetInstanceV1,
    type WidgetSizeV1,
} from '@happier-dev/protocol/widgets';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';

import { HubWidgetSection } from './HubWidgetSection';
import { useHomeWidgetCandidates } from './layout/useHomeWidgetCandidates';

/** The built-in widgets the lighter hub (Settings › Overview) shows as sections, at Home's default size. */
export type HubBuiltinWidgetId = 'usage_capacity';

/**
 * One built-in widget as a page section outside Home's layout (lab H1 Machines and Usage): the same
 * widget body, states and reserved room Home mounts, at its declared default size, under the page's
 * own section title and sheet instead of the widget's card chrome. It is not part of the Account's
 * Home layout and has no menu. (Machines composes its own rows from the fleet model: OverviewMachinesSection.)
 * A built-in this Account cannot show (switched off, not installed) leaves no hole.
 */
export const HubBuiltinWidgetSection = React.memo(function HubBuiltinWidgetSection(props: Readonly<{
    id: HubBuiltinWidgetId;
    size?: WidgetSizeV1;
    testID: string;
}>) {
    const candidates = useHomeWidgetCandidates();
    const widget = React.useMemo(
        () => candidates.find(candidate => candidate.definition?.kind === 'builtin' && candidate.definition.id === props.id),
        [candidates, props.id],
    );
    const descriptor = React.useMemo(() => readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: props.id }), [props.id]);
    const instance = React.useMemo<WidgetInstanceV1 | null>(() => {
        return descriptor ? {
            v: 1,
            id: `hub:builtin:${props.id}`,
            definition: { kind: 'builtin', id: props.id },
            bindings: proposeWidgetInputDefaultBindingsV1(descriptor),
        } : null;
    }, [descriptor, props.id]);
    const tracker = useOptionalPluginUiScrollActivityTracker();
    if (!widget || !instance || !descriptor) return null;
    return (
        // The section owns the title and the sheet (lab H1 Usage); the widget's
        // frame is drawn bare inside it at content height, so the same body and states serve Home and here.
        // The bare frame sits in the sheet like any row content, at the rows' own insets.
        <ItemGroup title={widget.title}>
            <SectionContentRow showDivider={false}>
            <HubWidgetSection
                widget={widget}
                instance={instance}
                // The widget's declared default, as Home adds it (Machines: who needs you, the rest in a
                // line): `full` takes the viewport's height, which on a page is an unbounded, mostly
                // empty frame (Overview grew past 7000 px, fidelity 2026-10-11).
                size={props.size ?? descriptor.sizeDeclaration.defaultSize}
                menu={null}
                frameStyle="plain"
                sectionHost
                tracker={tracker}
                testID={props.testID}
            />
            </SectionContentRow>
        </ItemGroup>
    );
});
