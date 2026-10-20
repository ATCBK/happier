import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1, TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1 } from '@happier-dev/triage-sources/runtime';
import { invokeTriageMountedUiAction } from '../ui/mountedActions.js';
import { TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1, TriageTaskDraftV1Schema } from './tasksProtocol.js';
import { TRIAGE_TASK_DETAIL_DESTINATION_V1 } from '../composer/openEntryDetails.js';
import { stageTriageTaskDraft } from '../ui/taskDraftHandoff.js';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, TriageMountedUiInputV1Schema, TriageMountedSourceRevealInputV1Schema, TriageMountedSourceInsertInputV1Schema, type TriageMountedUiInputV1, type TriageMountedUiResultV1 } from './mountedUiProtocol.js';

export function createTriageMountedUiActionHandler(): PluginClientActionHandler<TriageMountedUiInputV1, TriageMountedUiResultV1> {
  return async (input, context) => {
    const parsed = TriageMountedUiInputV1Schema.parse(input);
    if (context.ephemeralSharedScope === null || context.signal.aborted) return { status: 'unavailable' };
    return await invokeTriageMountedUiAction(context.ephemeralSharedScope, parsed.mountId, parsed.operation, context.signal);
  };
}

export function createTriageMountedSourceRevealActionHandler(): PluginClientActionHandler<ReturnType<typeof TriageMountedSourceRevealInputV1Schema.parse>, TriageMountedUiResultV1> {
  return async (input, context) => {
    const parsed = TriageMountedSourceRevealInputV1Schema.parse(input);
    if (context.ephemeralSharedScope === null || context.signal.aborted) return { status: 'unavailable' };
    return await invokeTriageMountedUiAction(context.ephemeralSharedScope, parsed.mountId, parsed.operation, context.signal);
  };
}

export function createTriageMountedSourceInsertActionHandler(): PluginClientActionHandler<ReturnType<typeof TriageMountedSourceInsertInputV1Schema.parse>, TriageMountedUiResultV1> {
  return async (input, context) => {
    const parsed = TriageMountedSourceInsertInputV1Schema.parse(input);
    if (context.ephemeralSharedScope === null || context.signal.aborted) return { status: 'unavailable' };
    return await invokeTriageMountedUiAction(context.ephemeralSharedScope, parsed.mountId, parsed.operation, context.signal);
  };
}

export function activate(api: PluginClientApi): void {
  api.actions.register(TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1, async (input, context) => {
    const draft = TriageTaskDraftV1Schema.parse(input);
    const fields = draft.body === undefined && context.messageAction?.visibleText != null
      ? { ...draft, body: context.messageAction.visibleText } : draft;
    if (context.signal.aborted) return { status: 'unavailable' };
    const handoff = stageTriageTaskDraft(context.ephemeralSharedScope, fields);
    if (handoff === null) return { status: 'unavailable' };
    try {
      await context.ui.openSurface(TRIAGE_TASK_DETAIL_DESTINATION_V1, handoff.input,
        { subPath: 'tasks,mine', signal: context.signal });
      return { status: 'applied' };
    } catch {
      handoff.discard();
      return { status: 'unavailable' };
    }
  });
  api.actions.register(TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, createTriageMountedUiActionHandler());
  api.actions.register(TRIAGE_SOURCE_PANEL_REVEAL_ACTION_V1, createTriageMountedSourceRevealActionHandler());
  api.actions.register(TRIAGE_SOURCE_PANEL_INSERT_ACTION_V1, createTriageMountedSourceInsertActionHandler());
}
