import { z } from 'zod/mini';
import { EntityDragScopeV1Schema, EntityDragSessionAddressV1Schema } from '../plugins/ui/entityDragDrop.js';
import type { ActionInputFieldHint, PreNormalizedActionSpec } from './actionSpecs.js';

import { SESSION_CANVAS_ACTION_IDS, type SessionCanvasActionId } from './sessionCanvasActionIds.js';
export { SESSION_CANVAS_ACTION_IDS, type SessionCanvasActionId } from './sessionCanvasActionIds.js';
const id = z.string().check(z.trim(), z.minLength(1));
const scope = z.strictObject({ scope: EntityDragScopeV1Schema, canvasKey: id });
const tab = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { tabId: id }));
const placement = z.enum(['center', 'left', 'right', 'up', 'down']);
export const SESSION_CANVAS_ACTION_INPUT_SCHEMAS = {
  'session.canvas.tabs.list': scope,
  'session.canvas.tabs.open': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { sessionId: id, leafId: id, placement: z._default(placement, 'center'), beforeTabId: z.optional(z.nullable(id)) })),
  'session.canvas.tabs.activate': tab,
  'session.canvas.tabs.close': tab,
  'session.canvas.tabs.move': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(tab, { targetLeafId: id, placement: z._default(placement, 'center'), beforeTabId: z.optional(z.nullable(id)) })),
  'session.canvas.tabs.reorder': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(tab, { beforeTabId: z.nullable(id) })),
  'session.canvas.tabs.pin': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(tab, { pinned: z.boolean() })),
} as const;
const unavailable = z.strictObject({ status: z.literal('unavailable') });
const refused = z.strictObject({ status: z.literal('refused'), reason: id });
const mutation = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied') }), z.strictObject({ status: z.literal('unchanged') }), unavailable, refused,
]);
const list = z.discriminatedUnion('status', [unavailable, refused, z.strictObject({
  status: z.literal('listed'), focusedLeafId: z.nullable(id), maximizedLeafId: z.nullable(id),
  leaves: z.array(z.strictObject({ id, tabIds: z.array(id), activeTabId: z.nullable(id) })),
  tabs: z.array(z.strictObject({ id, leafId: id, address: EntityDragSessionAddressV1Schema, pinned: z.boolean(), preview: z.boolean() })),
})]);
export const SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS = {
  'session.canvas.tabs.list': list,
  'session.canvas.tabs.open': mutation,
  'session.canvas.tabs.activate': mutation,
  'session.canvas.tabs.close': mutation,
  'session.canvas.tabs.move': mutation,
  'session.canvas.tabs.reorder': mutation,
  'session.canvas.tabs.pin': mutation,
} as const;
export type SessionCanvasActionOutcome = z.infer<typeof list> | z.infer<typeof mutation>;
const scopeHint = { path: 'scope', title: 'Exact Home and Account', widget: 'json', required: true } satisfies ActionInputFieldHint;
const canvasHint = { path: 'canvasKey', title: 'Mounted Session canvas key', widget: 'text', required: true } satisfies ActionInputFieldHint;
const tabHint = { path: 'tabId', title: 'Canvas tab id', widget: 'text', required: true } satisfies ActionInputFieldHint;
const beforeHint = { path: 'beforeTabId', title: 'Insert before tab (null appends)', widget: 'text' } satisfies ActionInputFieldHint;
const placementHint = { path: 'placement', title: 'Placement', widget: 'select', options: [
  { value: 'center', label: 'Same pane' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
  { value: 'up', label: 'Above' }, { value: 'down', label: 'Below' },
] } satisfies ActionInputFieldHint;
const inputFields = {
  'session.canvas.tabs.list': [scopeHint, canvasHint],
  'session.canvas.tabs.open': [scopeHint, canvasHint,
    { path: 'sessionId', title: 'Session id', prompt: 'Which session?', widget: 'text', required: true },
    { path: 'leafId', title: 'Destination pane id', widget: 'text', required: true }, placementHint, beforeHint],
  'session.canvas.tabs.activate': [scopeHint, canvasHint, tabHint],
  'session.canvas.tabs.close': [scopeHint, canvasHint, tabHint],
  'session.canvas.tabs.move': [scopeHint, canvasHint, tabHint,
    { path: 'targetLeafId', title: 'Destination pane id', widget: 'text', required: true }, placementHint, beforeHint],
  'session.canvas.tabs.reorder': [scopeHint, canvasHint, tabHint, { ...beforeHint, required: true }],
  'session.canvas.tabs.pin': [scopeHint, canvasHint, tabHint, { path: 'pinned', title: 'Keep pinned', widget: 'boolean', required: true }],
} satisfies Record<SessionCanvasActionId, readonly ActionInputFieldHint[]>;
function row<const T extends SessionCanvasActionId>(actionId: T, title: string) {
  return {
    id: actionId, approval: { result: 'required' }, title, description: 'Operate on the answering mounted Session canvas in the exact Home, Account and workspace. Opening keeps existing Sessions; an unavailable canvas performs no effect.',
    safety: 'safe', sideEffectClass: actionId === 'session.canvas.tabs.list' ? 'read' : 'external',
    executionPlacement: 'client', placements: [],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { commands: [{ path: actionId.split('.'), visibility: 'canonical' }] },
    bindings: { mcpToolName: actionId.replaceAll('.', '_') },
    inputSchema: SESSION_CANVAS_ACTION_INPUT_SCHEMAS[actionId], outputSchema: SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS[actionId],
    inputHints: { title, fields: inputFields[actionId] },
  } satisfies PreNormalizedActionSpec;
}
export const SESSION_CANVAS_ACTION_SPECS = [
  row('session.canvas.tabs.list', 'List Session canvas tabs'), row('session.canvas.tabs.open', 'Open Session canvas tab'),
  row('session.canvas.tabs.activate', 'Activate Session canvas tab'), row('session.canvas.tabs.close', 'Close Session canvas tab'),
  row('session.canvas.tabs.move', 'Move Session canvas tab'), row('session.canvas.tabs.reorder', 'Reorder Session canvas tab'),
  row('session.canvas.tabs.pin', 'Pin Session canvas tab'),
] as const;
export function isSessionCanvasActionId(value: string): value is SessionCanvasActionId {
  return (SESSION_CANVAS_ACTION_IDS as readonly string[]).includes(value);
}
