import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { WorkspaceAddressV1Schema } from '../../workspaces/workspaceRefV1.js';
import { WorkspaceAnchorV1Schema, WorkspaceAnchorSourceV1Schema } from '../../workspace/anchors/v1.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginUiInstanceKeyV1Schema } from './semanticCommands.js';

// Keep the existing anchor vocabulary and refinements, with closed routing ingress.
const OriginFileAnchorV1Schema = lazyZodSchema(() => z.union(WorkspaceAnchorV1Schema.options.map(option => option.strict())));

/** Original destination, independent of the editable execution placement. */
export const PluginUiNewSessionSeedOriginV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('project'),
  accountId: z.string().trim().min(1),
  workspace: WorkspaceAddressV1Schema,
  page: z.enum(['overview', 'code', 'changes', 'scripts', 'services', 'context']),
  /** Omitted by incumbent setup/discussion seeds; ordinary New session is never setup evidence. */
  purpose: z.literal('session').optional(),
  comparisonId: z.string().trim().min(1).optional(),
  layoutId: z.string().trim().min(1).optional(),
  attachedDashboard: z.object({ sourceId: z.string().trim().min(1), artifactId: z.string().trim().min(1),
    serverId: z.string().trim().min(1).optional() }).strict().optional(),
  codeLocation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('folder'), path: z.string() }).strict(),
    z.object({ kind: z.literal('file'), path: z.string().min(1) }).strict(),
  ]).optional(),
  resource: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path: z.string().min(1), anchor: OriginFileAnchorV1Schema.optional(),
      anchorSource: WorkspaceAnchorSourceV1Schema.optional() }).strict(),
    z.object({ kind: z.literal('commit'), sha: z.string().trim().min(1) }).strict(),
  ]).optional(),
  surface: z.enum(['overview', 'code', 'changes', 'scripts', 'services', 'context', 'browse', 'git', 'tabs', 'terminal', 'browser']).optional(),
  companion: z.union([
    z.enum(['files', 'git', 'scripts', 'services', 'terminal', 'browser']),
    z.object({ kind: z.literal('plugin'), destination: asProtocolZod(PluginContributionIdentityV1Schema),
      instanceKey: PluginUiInstanceKeyV1Schema.optional() }).strict(),
  ]).optional(),
}).strict());
export type PluginUiNewSessionSeedOriginV1 = z.infer<typeof PluginUiNewSessionSeedOriginV1Schema>;
export const StoredPluginUiNewSessionSeedOriginV1Schema = createStoredReadSchema(PluginUiNewSessionSeedOriginV1Schema);
