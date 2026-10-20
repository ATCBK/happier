import * as React from 'react';
import { defineUiSurface, useLivePluginResource } from '@happier-dev/plugin-ui';
import { Action, ErrorState, LoadingState, Metric, Stack, Text } from '@happier-dev/plugin-ui/components';
import { readSummary } from '../summary.js';

function ProgressWidget() {
    const { resource, refresh } = useLivePluginResource('summary');
    const retry = <Action.Refresh title="Refresh progress" onRefresh={refresh} />;
    if (!resource.value) return resource.error ? <ErrorState layout="line" title="Progress could not be loaded" action={retry} />
        : <LoadingState layout="line" title="Loading progress" />;
    const summary = resource.value.contentType === 'application/json' ? readSummary(resource.value.bytes) : null;
    if (!summary) return <ErrorState layout="line" title="Progress could not be read" action={retry} />;
    return <Stack gap="small"><Metric label="Reviews complete" value={summary.completed} />
        <Text value={`Daily goal · ${summary.goal}`} tone="secondary" />
        {resource.error ? <ErrorState layout="line" title="Could not refresh; showing the last progress" action={retry} /> : null}
        <Action.Execute action="set-completed" input={{ completed: summary.completed + 1 }} title="Record a review" testID="qa-widget-record" />
        <Action.OpenSurface view="overview" title="Review progress" testID="qa-widget-overview" />
    </Stack>;
}

export const renderSurface = defineUiSurface(ProgressWidget);
