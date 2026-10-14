import * as React from 'react';
import { SkillFoundListResultV1Schema, type SkillFoundListResultV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { SkillsFoundPage } from '@/components/settings/skills/found/SkillsFoundScreen';
import type { FoundMachineScan } from '@/sync/domains/skills/useFoundSkills';
import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';

/**
 * Dev-only (P6 U6.5 intermediate, deleted at landing): the Found page in the states the QA daemon's one
 * machine cannot show — several machines, an offline one with a last-known list, a failed scan, an older
 * machine, plugin-owned skills and a masked name. `?state=` picks the cast: `default`, `failed`, `older`,
 * `empty`, `looking`, `unseen`. Adding is a local pretend (no machine transfer runs).
 */
type Item = SkillFoundListResultV1['items'][number];
const item = (name: string, description: string, root: string, agents: string[], extra: Partial<Item> = {}): Item => ({
  name, description, path: `${root}/${name}`, digest: `d-${name}`, agents: agents as Item['agents'], scope: 'user',
  inLibrary: null, masksLibrary: false, happierInstalled: false, pluginOwned: null, ...extra,
});
const claude = '~/.claude/skills';
const codex = '~/.codex/skills';

function result(items: Item[], failedRoot?: string): SkillFoundListResultV1 {
  return SkillFoundListResultV1Schema.parse({
    scannedAt: Date.now() - 60_000,
    roots: [
      { path: claude, scope: 'user', agents: ['claude'], status: 'ok' },
      { path: codex, scope: 'user', agents: ['codex'], status: 'ok' },
      ...(failedRoot ? [{ path: failedRoot, scope: 'plugin', agents: ['claude'], status: 'failed' }] : []),
    ],
    items,
  });
}

const MBP = result([
  item('deploy-checklist', 'Release checklist for client-site.', claude, ['claude'], { masksLibrary: true }),
  item('grill-me', 'Ask hard questions about a plan before any code is written.', claude, ['claude', 'codex']),
  item('ui-polish', 'Small details that make interfaces feel finished.', codex, ['codex']),
  item('frontend:lint-fix', 'Fix lint errors the way this team prefers.', '~/.claude/plugins/frontend/skills', ['claude'], {
    scope: 'plugin', pluginOwned: { pluginName: 'frontend' },
  }),
  item('release-notes', 'Draft release notes from merged pull requests.', claude, ['claude'], { inLibrary: 'release-notes', happierInstalled: true }),
]);
const FILLER = ['pdf', 'docx', 'xlsx', 'slides', 'sql-tuning', 'log-triage', 'api-design', 'accessibility', 'changelog', 'seo-audit', 'unit-tests', 'refactor'];
const withFiller = (count: number) => result([
  ...MBP.items,
  ...FILLER.slice(0, count).map((name) => item(name, `A skill about ${name.replace('-', ' ')}.`, claude, ['claude'])),
], '~/.claude/plugins/cache/old/skills');
const NL2 = result([
  item('server-hardening', 'Check an Ubuntu host against the team’s baseline.', codex, ['codex']),
  item('logs-triage', 'Summarise a log file into likely causes.', codex, ['codex']),
]);
const WIN = result([
  item('excel-reports', 'Build monthly reports from the finance workbook.', claude, ['claude']),
  item('invoice-check', 'Check an invoice against its purchase order.', claude, ['claude']),
]);

const machine = (machineId: string, name: string, offline = false): ReachMachine => ({
  machineId, name, platform: 'posix', agentIds: ['claude', 'codex'], offline, lastSeenAt: offline ? Date.now() - 3 * 3600_000 : null,
});
const NAMES: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex' };

export function SkillsFoundSpecimen(props: Readonly<{ state?: string }>) {
  const state = props.state ?? 'default';
  const [added, setAdded] = React.useState<ReadonlySet<string>>(() => new Set());
  const machines = React.useMemo(() => [
    machine('mbp', 'MacBook Pro'),
    machine('nl2', 'nl2'),
    machine('win', 'Windows desktop', true),
    ...(state === 'unseen' ? [machine('x1', 'Old laptop', true), machine('x2', 'Spare box', true)] : []),
  ], [state]);
  const scanOf = React.useCallback((m: ReachMachine): FoundMachineScan => {
    const base = { machineId: m.machineId, scanning: false, failure: null } as const;
    const apply = (r: SkillFoundListResultV1): SkillFoundListResultV1 => ({
      ...r, items: r.items.map((entry) => added.has(entry.path) ? { ...entry, inLibrary: entry.name, masksLibrary: false } : entry),
    });
    switch (m.machineId) {
      case 'mbp': return { ...base, result: apply(state === 'empty' ? result([]) : state === 'looking' ? withFiller(0) : withFiller(state === 'fold' ? FILLER.length : 3)), ...(state === 'looking' ? { scanning: true } : {}) };
      case 'nl2':
        if (state === 'failed') return { ...base, result: null, failure: 'failed' };
        if (state === 'older') return { ...base, result: null, failure: 'older_machine' };
        if (state === 'looking') return { ...base, result: null, scanning: true };
        return { ...base, result: apply(NL2) };
      case 'win': return { ...base, result: apply(WIN) };
      default: return { ...base, result: null };
    }
  }, [added, state]);
  const adopt = React.useCallback(async (_machineId: string, items: readonly Readonly<{ name: string; path: string }>[]) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    setAdded((prev) => new Set([...prev, ...items.map((entry) => entry.path)]));
    return { skillIds: items.map((entry) => entry.name), incomplete: false };
  }, []);
  const readBoth = React.useCallback(async () => ({
    yours: '---\nname: deploy-checklist\ndescription: Walk the release checklist for client-site.\n---\n\n1. Run the smoke suite.\n2. Tag the release.\n3. Ask for sign-off.\n',
    theirs: '---\nname: deploy-checklist\ndescription: Release checklist for client-site.\n---\n\n1. Run the smoke suite.\n2. Tag the release and notify the channel.\n3. Ask for sign-off.\n4. Archive the build.\n',
  }), []);
  return (
    <SkillsFoundPage
      machines={machines}
      scanOf={scanOf}
      canCheckAgain
      checking={state === 'looking'}
      onCheckAgain={() => undefined}
      libraryIdByName={new Map([['deploy-checklist', 'deploy-checklist']])}
      libraryPending={false}
      agentName={(id) => NAMES[id] ?? id}
      onScan={async () => undefined}
      adopt={adopt}
      readBoth={readBoth}
    />
  );
}
