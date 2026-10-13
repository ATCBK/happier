import * as React from 'react';
import { projectReachForMachinesV1 } from '@happier-dev/protocol/reach/projectReachV1';
import type { ReachRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { applyReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';

import { buildCapabilityHeaderMeta } from '@/components/capabilities/facts/CapabilityFacts';
import { WhereItsOnControl, type WhereItsOnControlProps } from '@/components/capabilities/where/WhereItsOnControl';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';

/**
 * Dev-only (P5 U5.3 intermediate): "Where it's on" with the lab's cast (`cw-A`, `cw-A0`, `cw-O`, `cw-O2`) on a
 * skill detail page. Deleted when the control lands with its first product page (P6 U6.3 / P7 U7.8).
 * `?scene=rich|clientOnly|off|nl2` picks the rules; `?fail=1` refuses every change; `?readonly=1` shows the read-only form.
 */
const MACHINES = [
  { machineId: 'mbp', name: 'MacBook Pro', online: true, platform: 'posix' as const },
  { machineId: 'nl2', name: 'nl2', online: true, platform: 'posix' as const },
  { machineId: 'win', name: 'Windows desktop', online: false, platform: 'win32' as const },
];
const AGENTS = ['claude', 'codex', 'gemini', 'opencode'];
const PROJECTS = [
  { projectKey: 'happier', name: 'happier', machineCount: 3 },
  { projectKey: 'client-site', name: 'client-site', machineCount: 2 },
];

let nextId = 0;
const rule = (input: Omit<ReachRuleV1, 'id' | 'createdAt' | 'updatedAt'>): ReachRuleV1 => ({ ...input, id: `r${nextId++}`, createdAt: 1, updatedAt: 1 });
const everywhere = (enabled: boolean) => rule({ target: { t: 'allMachines' }, enabled });

const SCENES: Record<string, Readonly<{ title: string; description: string; rules: readonly ReachRuleV1[] }>> = {
  rich: {
    title: 'code-review',
    description: 'Review a diff against the repo’s standards before you merge.',
    rules: [everywhere(true), rule({ target: { t: 'allMachines' }, agentId: 'gemini', enabled: false }), rule({ target: { t: 'project', projectKey: 'client-site' }, enabled: false })],
  },
  clientOnly: {
    title: 'frontend-design',
    description: 'Distinctive, production-grade web UI that avoids the generic look.',
    rules: [everywhere(false), rule({ target: { t: 'project', projectKey: 'client-site' }, enabled: true })],
  },
  off: {
    title: 'frontend-design',
    description: 'Distinctive, production-grade web UI that avoids the generic look.',
    rules: [everywhere(false)],
  },
  nl2: {
    title: 'server-hardening',
    description: 'Check an Ubuntu host against the team’s baseline.',
    rules: [everywhere(false), rule({ target: { t: 'machine', machineId: 'nl2' }, agentId: 'codex', enabled: true })],
  },
};

export function WhereItsOnSpecimen(props: Readonly<{ scene?: string; fail: boolean; readOnly: boolean }>) {
  const scene = SCENES[props.scene ?? 'rich'] ?? SCENES.rich!;
  const [rules, setRules] = React.useState<readonly ReachRuleV1[]>(scene.rules);
  React.useEffect(() => setRules(scene.rules), [scene]);
  const projection = React.useMemo(() => projectReachForMachinesV1(rules, {
    machines: MACHINES.map((machine) => ({ machineId: machine.machineId, platform: machine.platform, agentIds: AGENTS })),
  }), [rules]);
  const onChange = React.useCallback<WhereItsOnControlProps['onChange']>(async (change) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (props.fail) return { ok: false, message: 'catalog_unavailable' };
    setRules((current) => applyReachRulesChangeV1(current, change, { nowMs: Date.now(), newId: () => `r${nextId++}` }));
    return { ok: true };
  }, [props.fail]);
  return (
    <ItemList>
      <PageHeader
        title={scene.title}
        description={scene.description}
        meta={buildCapabilityHeaderMeta({ source: { kind: 'git', label: 'anthropics/skills', ref: '4f2a1c9' }, trust: 'has_files', cost: { tokensWhenUsed: 1400 } })}
      />
      <WhereItsOnControl
        kind="skill"
        rules={rules}
        status="ready"
        projection={projection}
        places={{ agentIds: AGENTS, machines: MACHINES, projects: PROJECTS }}
        onChange={onChange}
        presentation="section"
        {...(props.readOnly ? { readOnlyReason: 'Found on nl2. Add it to your library to choose where it’s on.' } : {})}
        testID="where"
      />
      <ItemGroup title="Instructions">
        <Item title="Review a diff" subtitle="Read reference/standards.md and the repo’s own AGENTS.md, then check the change along two axes." showChevron={false} />
      </ItemGroup>
    </ItemList>
  );
}
