import * as React from 'react';
import { defineUiSurface, useLivePluginResource } from '@happier-dev/plugin-ui';
import { Action, EmptyState, ErrorState, Item, ItemGroup, LoadingState, PageHeader, Screen, ScrollArea, Stack, WidgetSurface } from '@happier-dev/plugin-ui/components';
import { readSummary } from '../summary.js';

function ProgressOverview() {
    const { resource, refresh } = useLivePluginResource('summary');
    const summary = resource.value?.contentType === 'application/json' ? readSummary(resource.value.bytes) : null;
    const retry = <Action.Refresh title="Refresh progress" onRefresh={refresh} />;
    return <Screen><ScrollArea accessibilityLabel="QA review progress"><Stack gap="medium">
        <PageHeader title="Review progress" description="Record completed reviews and place the live progress widget on Home. This QA data resets on reload." />
        {!resource.value ? resource.error ? <ErrorState title="Progress could not be loaded" action={retry} /> : <LoadingState title="Loading progress" />
            : !summary ? <ErrorState title="Progress could not be read" action={retry} />
                : <ItemGroup title="Today"><Item title="Completed reviews" detail={String(summary.completed)}
                    accessory={<Action.Execute action="set-completed" input={{ completed: 0 }} title="Reset" testID="qa-progress-reset" />} />
                    <Item title="Daily goal" detail={String(summary.goal)} /></ItemGroup>}
        {summary?.completed === 0 ? <EmptyState layout="line" title="Begin a review" description="Record your first completed review."
            action={<Action.Execute action="set-completed" input={{ completed: 1 }} title="Record a review" />} /> : null}
        {resource.error && summary ? <ErrorState layout="line" title="Could not refresh; showing the last progress" action={retry} /> : null}
        <WidgetSurface area="pinned" context={{}} title="Pinned progress" />
    </Stack></ScrollArea></Screen>;
}

export const renderSurface = defineUiSurface(ProgressOverview);
