import { expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { PluginActionInputById, PluginActionResultById } from './actionSpecs.js';
import type { SESSION_CANVAS_ACTION_INPUT_SCHEMAS, SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS } from './sessionCanvasActionFamily.js';
import type { WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1 } from '../widgets/actionsV1.js';
import type { WidgetDefinitionActionInputSchemasV1, WidgetDefinitionActionOutputSchemasV1 } from '../widgets/definitionActionsV1.js';
import type { MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS, MACHINE_PROCESSES_ACTION_OUTPUT_SCHEMAS, MACHINE_PROCESSES_ACTION_SPECS } from './specs/machineProcesses.js';
import type { MACHINE_STORAGE_ACTION_INPUT_SCHEMAS, MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS, MACHINE_STORAGE_ACTION_SPECS } from './specs/storage.js';

it('preserves exact Storage input and result schemas in the public plugin Action types', () => {
  type CheckSpec = Extract<(typeof MACHINE_STORAGE_ACTION_SPECS)[number], { id: 'machines.storage.items.check' }>;
  type PileSpec = Extract<(typeof MACHINE_STORAGE_ACTION_SPECS)[number], { id: 'machines.storage.pile.get' }>;
  expectTypeOf<z.input<CheckSpec['inputSchema']>>()
    .toEqualTypeOf<z.input<typeof MACHINE_STORAGE_ACTION_INPUT_SCHEMAS['machines.storage.items.check']>>();
  expectTypeOf<z.output<PileSpec['outputSchema']>>()
    .toEqualTypeOf<z.output<typeof MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS['machines.storage.pile.get']>>();
  expectTypeOf<PluginActionInputById['machines.storage.items.check']>()
    .toEqualTypeOf<z.input<typeof MACHINE_STORAGE_ACTION_INPUT_SCHEMAS['machines.storage.items.check']>>();
  expectTypeOf<PluginActionResultById['machines.storage.pile.get']>()
    .toEqualTypeOf<z.output<typeof MACHINE_STORAGE_ACTION_OUTPUT_SCHEMAS['machines.storage.pile.get']>>();
});

it('preserves exact Process input and result schemas in the public plugin Action types', () => {
  type GetSpec = Extract<(typeof MACHINE_PROCESSES_ACTION_SPECS)[number], { id: 'machines.processes.get' }>;
  type ListSpec = Extract<(typeof MACHINE_PROCESSES_ACTION_SPECS)[number], { id: 'machines.processes.list' }>;
  expectTypeOf<z.input<GetSpec['inputSchema']>>()
    .toEqualTypeOf<z.input<typeof MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS['machines.processes.get']>>();
  expectTypeOf<z.output<ListSpec['outputSchema']>>()
    .toEqualTypeOf<z.output<typeof MACHINE_PROCESSES_ACTION_OUTPUT_SCHEMAS['machines.processes.list']>>();
  expectTypeOf<PluginActionInputById['machines.processes.get']>()
    .toEqualTypeOf<z.input<typeof MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS['machines.processes.get']>>();
  expectTypeOf<PluginActionResultById['machines.processes.list']>()
    .toEqualTypeOf<z.output<typeof MACHINE_PROCESSES_ACTION_OUTPUT_SCHEMAS['machines.processes.list']>>();
});

it('preserves per-ID Canvas and widget schema carriers in the public plugin Action types', () => {
  expectTypeOf<PluginActionInputById['session.canvas.tabs.open']>()
    .toEqualTypeOf<z.input<typeof SESSION_CANVAS_ACTION_INPUT_SCHEMAS['session.canvas.tabs.open']>>();
  expectTypeOf<PluginActionResultById['session.canvas.tabs.open']>()
    .toEqualTypeOf<z.output<typeof SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS['session.canvas.tabs.open']>>();
  expectTypeOf<PluginActionInputById['widgets.catalog.list']>()
    .toEqualTypeOf<z.input<typeof WidgetInstanceActionInputSchemasV1['widgets.catalog.list']>>();
  expectTypeOf<PluginActionResultById['widgets.catalog.list']>()
    .toEqualTypeOf<z.output<typeof WidgetInstanceActionOutputSchemasV1['widgets.catalog.list']>>();
  expectTypeOf<PluginActionInputById['widgets.definition.update']>()
    .toEqualTypeOf<z.input<typeof WidgetDefinitionActionInputSchemasV1['widgets.definition.update']>>();
  expectTypeOf<PluginActionResultById['widgets.definition.update']>()
    .toEqualTypeOf<z.output<typeof WidgetDefinitionActionOutputSchemasV1['widgets.definition.update']>>();
});
