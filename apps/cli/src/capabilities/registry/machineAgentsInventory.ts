import { MachineAcpInventoryRequestSchema, type MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { resolveAcpPlatformFitV1 } from '@happier-dev/protocol/acp/catalog/registry/acpPlatformFitV1';
import { listManagedAcpInstalls } from '@/agent/acp/catalog/registry/managedAgentInstalls';
import { CapabilityError } from '../errors';
import type { Capability } from '../service';

/** Physical install observations for caller-owned definitions, never an Account census or launch admission. */
export function createAcpAgentInventoryCapability(input: Readonly<{
  env?: NodeJS.ProcessEnv; platform?: string; arch?: string; accountId?: string;
}> = {}): Capability {
  return { descriptor: { id: 'tool.acpAgentInventory', kind: 'tool', title: 'ACP agent installs' },
    async detect({ request, context }) {
      const parsed = MachineAcpInventoryRequestSchema.safeParse(request.params);
      if (!parsed.success) throw new CapabilityError('Invalid ACP inventory request', 'invalid-request');
      const accountId = context.accountId ?? input.accountId;
      if (!accountId) throw new CapabilityError('ACP inventory requires an admitted Account', 'account-unavailable');
      const installs = await listManagedAcpInstalls({ env: input.env, accountId });
      const items: MachineAgentInventoryItem[] = parsed.data.definitions.map(definition => {
        const matching = installs.filter(install => install.definitionId === definition.definitionId && install.kind === definition.launch.kind);
        const install = matching.find(install => install.version === definition.launch.version) ?? matching[0];
        const fit = resolveAcpPlatformFitV1(definition.launch, { platform: input.platform ?? process.platform, arch: input.arch ?? process.arch });
        return { agentId: 'custom-acp', definitionId: definition.definitionId, title: definition.title,
          installed: Boolean(install), version: install?.version ?? null, managed: Boolean(install), fit,
          latestVersion: definition.launch.kind === 'command' ? null : definition.launch.version,
          update: { supported: Boolean(install), command: null },
          signIn: { status: 'unknown', loginSupport: 'unsupported' },
          platform: fit.kind === 'cant_run' ? { supported: false, reason: 'arch' } : { supported: true },
          install: { available: fit.kind === 'can_run', mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        };
      });
      return { items };
    },
  };
}
