import { getActionSpec } from '@happier-dev/protocol/actions';
import { ACTION_IDS, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
    createHappierActionToolNameIndex as createBindingIndex,
    readHappierActionExecuteActionId,
    readHappierActionId,
} from '@happier-dev/protocol/actions/happierActionToolResult';

/** Existing authenticated host consumers project bindings from the complete catalog. */
export function createHappierActionToolNameIndex<T extends string>(ids: readonly T[]): ReadonlyMap<string, T> {
    return createBindingIndex(ids.map(actionId => ({ actionId, name: getActionSpec(actionId as ActionId).bindings?.mcpToolName })));
}

const KNOWN_ACTION_IDS: ReadonlySet<string> = new Set(ACTION_IDS);
let actionToolNames: ReadonlyMap<string, ActionId> | null = null;

/** The Happier Action a first-party tool call runs: the `action_execute` operand, else the Action's own binding. */
export function readHappierActionCallId(toolName: string, input: unknown): ActionId | null {
    const executed = readHappierActionExecuteActionId(toolName, input, (id): id is ActionId => KNOWN_ACTION_IDS.has(id));
    if (executed) return executed;
    actionToolNames ??= createHappierActionToolNameIndex<ActionId>(ACTION_IDS as readonly ActionId[]);
    return readHappierActionId(toolName, actionToolNames);
}

export {
    isRecord,
    readHappierActionId,
    readHappierActionToolPayload,
    readHappierActionExecuteActionId,
    readHappierActionToolResultCandidates,
} from '@happier-dev/protocol/actions/happierActionToolResult';
