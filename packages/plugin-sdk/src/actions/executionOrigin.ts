import {
  PluginMachineExecutionOriginV1Schema as canonicalPluginMachineExecutionOriginV1Schema,
  PluginMachineExecutionRoutingV1Schema as canonicalPluginMachineExecutionRoutingV1Schema,
  PluginMachineExecutionRoutingV1JsonSchema as canonicalPluginMachineExecutionRoutingV1JsonSchema,
  getPluginMachineExecutionRouting as canonicalGetPluginMachineExecutionRouting,
  arePluginMachineExecutionRoutingsEqual as canonicalArePluginMachineExecutionRoutingsEqual,
} from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import type { PluginMachineExecutionOriginV1 } from './actionTypeMap.generated.js';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';
import type { PluginJsonSchema } from '../identity.js';

/** Closed host placement precondition, independent of the admitted implementation's custody. */
export type PluginMachineExecutionRoutingV1 = Readonly<{
  serverIdentityId: string;
  machineId: string;
  pluginId: string;
}>;

export const PluginMachineExecutionRoutingV1Schema: Readonly<{
  parse(value: unknown): PluginMachineExecutionRoutingV1;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: PluginMachineExecutionRoutingV1 }>
    | Readonly<{ success: false; error: unknown }>;
}> = /* @__PURE__ */ projectProtocolValue(canonicalPluginMachineExecutionRoutingV1Schema);
export const PluginMachineExecutionRoutingV1JsonSchema: PluginJsonSchema =
  /* @__PURE__ */ projectProtocolValue(canonicalPluginMachineExecutionRoutingV1JsonSchema);
export const getPluginMachineExecutionRouting: (
  origin: PluginMachineExecutionOriginV1,
) => PluginMachineExecutionRoutingV1 = /* @__PURE__ */ projectProtocolValue(canonicalGetPluginMachineExecutionRouting);
export const arePluginMachineExecutionRoutingsEqual: (
  left: PluginMachineExecutionRoutingV1,
  right: PluginMachineExecutionRoutingV1,
) => boolean = /* @__PURE__ */ projectProtocolValue(canonicalArePluginMachineExecutionRoutingsEqual);

/** Exact Protocol execution-origin evidence returned by contributed Action execution. */
export const PluginMachineExecutionOriginV1Schema: Readonly<{
  parse(value: unknown): PluginMachineExecutionOriginV1;
  safeParse(value: unknown):
    | Readonly<{ success: true; data: PluginMachineExecutionOriginV1 }>
    | Readonly<{ success: false; error: unknown }>;
}> = /* @__PURE__ */ projectProtocolValue(canonicalPluginMachineExecutionOriginV1Schema);
/** Exact Protocol execution-origin fact used for contributed Action currentness. */
export type { PluginMachineExecutionOriginV1 };
