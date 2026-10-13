import { z } from 'zod';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { RegistryItemPointerV1Schema } from '../../../registries/registryItemsV1.js';
import { AcpBackendDefinitionV1Schema } from '../settingsV1.js';

export const AgentsAcpBackendsInstallFromRegistryInputV1Schema = lazyZodSchema(() => z.object({
  fromRegistry: RegistryItemPointerV1Schema,
  installOn: z.array(z.string().trim().min(1)).refine(ids => new Set(ids).size === ids.length,
    'An install target may appear only once').optional(),
}).strict());
export type AgentsAcpBackendsInstallFromRegistryInputV1 = z.infer<typeof AgentsAcpBackendsInstallFromRegistryInputV1Schema>;

export const AgentsAcpBackendsInstallFromRegistryOutputV1Schema = lazyZodSchema(() => z.object({
  definition: AcpBackendDefinitionV1Schema,
  jobs: z.array(z.object({ machineId: z.string().min(1), jobId: z.string().min(1) }).strict()),
}).strict());
export type AgentsAcpBackendsInstallFromRegistryOutputV1 = z.infer<typeof AgentsAcpBackendsInstallFromRegistryOutputV1Schema>;
