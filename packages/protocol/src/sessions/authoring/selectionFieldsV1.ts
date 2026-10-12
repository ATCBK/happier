import { z } from 'zod';
import { AgentSessionToolPolicyShapeV1 } from '../../runtime/permissionIntentV1.js';
import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { AcpConfigOptionOverridesV1Schema } from '../metadata/metadataOverridesV1.js';
import { WindowsRemoteSessionLaunchModeSchema } from '../metadata/windowsRemoteSessionLaunchMode.js';
import { WindowsTerminalWindowNameSchema } from '../metadata/windowsTerminalWindowName.js';
import { SessionAuthoringTerminalV1Schema } from './creationFieldsV1.js';

/** Shared selection schemas stay below the catalog: a catalogued birth trigger contains a Workflow. */
export const SessionAuthoringSelectionFieldsV1 = {
  ...AgentSessionToolPolicyShapeV1,
  agentTarget: AgentExecutionTargetV1Schema.nullable(),
  profileId: z.string().nullable(),
  permissionMode: z.string().trim().min(1).nullable(),
  acpSessionModeId: z.string().trim().min(1).nullable(),
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.nullable(),
  capabilitySelection: SessionCapabilitySelectionAuthoringV1Schema.nullable(),
  transcriptStorage: z.enum(['persisted', 'direct']).nullable(),
  terminal: SessionAuthoringTerminalV1Schema.nullable(),
  windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchModeSchema.nullable(),
  windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).nullable(),
  windowsTerminalWindowName: WindowsTerminalWindowNameSchema.nullable(),
} as const;
