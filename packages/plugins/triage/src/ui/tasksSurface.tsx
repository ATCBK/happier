import * as React from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { TriageListShell } from './shell/root.js';
import { parseTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { TriageTaskDraftLaunchV1Schema } from '../actions/tasksProtocol.js';

/** A page of the same plugin, using its sole list, route, selection and detail owners. */
export const renderSurface: RenderSurface = defineUiSurface((context) => {
  const launch = React.useMemo(() => {
    const parsed = parseTriageEntryDetailLaunchInput(context.launchInput);
    return parsed.status === 'valid' ? parsed.input : undefined;
  }, [context.launchInput]);
  const createDraft = React.useMemo(() => {
    const parsed = TriageTaskDraftLaunchV1Schema.safeParse(context.launchInput);
    return parsed.success ? parsed.data.fields : undefined;
  }, [context.launchInput]);
  return <TriageListShell tasksPage {...(context.subPath === undefined ? {} : { subPath: context.subPath })}
    {...(launch === undefined ? {} : { launch })} {...(createDraft === undefined ? {} : { createDraft })} />;
});
