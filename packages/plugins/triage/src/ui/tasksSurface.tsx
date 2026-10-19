import * as React from 'react';
import { Banner, defineUiSurface, usePluginTranslation, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { TriageListShell } from './shell/root.js';
import { parseTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { readTriageTaskDraftLaunch } from './taskDraftHandoff.js';

/** A page of the same plugin, using its sole list, route, selection and detail owners. */
export const renderSurface: RenderSurface = defineUiSurface((context) => {
  const scope = usePluginUiEphemeralSharedScope();
  const text = usePluginTranslation();
  const launch = React.useMemo(() => {
    const parsed = parseTriageEntryDetailLaunchInput(context.launchInput);
    return parsed.status === 'valid' ? parsed.input : undefined;
  }, [context.launchInput]);
  const createDraft = React.useMemo(() => readTriageTaskDraftLaunch(scope, context.launchInput), [scope, context.launchInput]);
  React.useEffect(() => {
    if (createDraft.status === 'ready') createDraft.discard();
  }, [createDraft]);
  if (createDraft.status === 'unavailable') return <Banner tone="warning"
    title={text('plugins.triage.tasks.draftUnavailable', 'This task draft is no longer available. Open it again from the message or action.')} />;
  return <TriageListShell tasksPage {...(context.subPath === undefined ? {} : { subPath: context.subPath })}
    {...(launch === undefined ? {} : { launch })} {...(createDraft.status === 'ready' ? { createDraft: createDraft.fields } : {})} />;
});
