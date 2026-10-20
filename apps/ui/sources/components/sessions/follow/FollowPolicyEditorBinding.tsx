import * as React from 'react';
import { FollowPolicyEditor, type FollowPolicyEditorDelivery, type FollowPolicyEditorReceiver } from '@happier-dev/plugin-ui';
import type { FollowPolicyEditorEditV1, FollowPolicyEditorModelV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';
import type { FollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useListPresentation } from '@/components/ui/lists/listPresentation';

/** The shared editor names events by one id: `needs_you.<type>` or the event kind. */
function followEventId(event: FollowEventV1): string {
    return event.kind === 'needs_you' ? `needs_you.${event.type}` : event.kind;
}

/**
 * Binds the shared presentational Follow policy editor to a Protocol editor projection. Personal Follow and
 * Session sources render the same presets and event delivery; each caller applies the edit through its own writer.
 */
export function FollowPolicyEditorBinding(props: Readonly<{
    model: FollowPolicyEditorModelV1;
    disabled: boolean;
    /** Who hears the events: a person (default; Push, Inbox) or a Session (Wake, Next turn). */
    receiver?: FollowPolicyEditorReceiver;
    onEditPolicy(edit: FollowPolicyEditorEditV1): void;
    testID: string;
}>) {
    const { model, onEditPolicy } = props;
    const events = React.useMemo(() => model.events.map((row) => ({ id: followEventId(row.event), delivery: row.delivery })), [model.events]);
    const selectPreset = React.useCallback((preset: string) => {
        const match = model.presets.find((candidate) => candidate === preset);
        if (match) onEditPolicy({ kind: 'preset', preset: match });
    }, [model.presets, onEditPolicy]);
    const setDelivery = React.useCallback((id: string, delivery: FollowPolicyEditorDelivery) => {
        const row = model.events.find((candidate) => followEventId(candidate.event) === id);
        if (row) onEditPolicy({ kind: 'event', event: row.event, delivery });
    }, [model.events, onEditPolicy]);
    return <FollowPolicyEditor testID={props.testID} receiver={props.receiver} preset={model.preset} presets={model.presets} events={events}
        disabled={props.disabled} onSelectPreset={selectPreset} onSetDelivery={setDelivery} />;
}

/**
 * The shared level editor where its host mounts it. On a page the scope sits outside the bare section, so the
 * public sections take the column's own inset once. A popover has no column edge: there the public sections draw
 * their own inset, level with the sheets and the footer, and a bare section around them would inset them twice.
 * Personal Follow and Session sources place the editor through this one wrapper.
 */
export function FollowPolicySection(props: Readonly<{ children: React.ReactNode }>) {
    const onPage = useListPresentation() === 'page';
    return <CoreCollectionScope>
        {onPage ? <ItemGroup surface="none">{props.children}</ItemGroup> : props.children}
    </CoreCollectionScope>;
}
