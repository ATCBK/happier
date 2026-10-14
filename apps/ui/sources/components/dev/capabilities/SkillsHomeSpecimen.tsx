import * as React from 'react';
import { SkillListItemV1Schema, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { SkillsHomepage } from '@/components/settings/skills/SkillsHomepage';
import { SkillsRegistryShelf } from '@/components/settings/skills/SkillsRegistryShelf';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { skillTextFile } from '@/components/settings/skills/detail/skillFileContent';
import { SkillsChoosePage } from '@/components/settings/skills/firstRun/SkillsChooseScreen';
import { buildSkillsFirstRunSelection } from '@/components/settings/skills/firstRun/skillsFirstRunSelection';
import type { SkillsFirstRun } from '@/components/settings/skills/firstRun/useSkillsFirstRun';
import { SkillsUpdatesPage } from '@/components/settings/skills/updates/SkillsUpdatesScreen';
import type { SkillUpdateDiffState, SkillsUpdatesController } from '@/components/settings/skills/updates/useSkillsUpdates';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';

/**
 * Dev-only (P6 U6.2 intermediate, deleted at landing): the Skills homepage in the states a seeded QA
 * Account cannot reach — `?state=empty` (a brand-new library), `error` (the read failed, Retry) and
 * `first` (the first-visit moment: migrated skills on, the rest waiting). Machines and their Agents
 * come from the live Account; only the library is a fixture, built through the strict `skills.list` schema.
 */
const NAMES: readonly Readonly<[string, string]>[] = [
  ['release-notes', 'Draft release notes from merged pull requests, grouped by what users notice.'],
  ['deploy-checklist', 'Walk the release checklist for client-site before a production deploy.'],
  ['brand-voice', 'Keep product copy short, plain and in the house voice.'],
  ['code-review', 'Review a diff against the repo’s standards before you merge.'],
  ['pdf', 'Read, fill and merge PDF files with Python.'],
  ['sql-migrations', 'Write reversible Postgres migrations and size-check them against production.'],
  ['frontend-design', 'Distinctive, production-grade web UI that avoids the generic look.'],
  ['meeting-notes', 'Turn a meeting transcript into decisions, owners and dates.'],
  ['incident-postmortem', 'A blameless postmortem from the incident timeline.'],
  ['docx', 'Create and edit Word documents, with tracked changes and comments.'],
  ['grill-me', 'Ask hard questions about a plan before any code is written.'],
  ['ui-polish', 'Small details that make interfaces feel finished.'],
];

function firstVisitItems(): readonly SkillListItemV1[] {
  return NAMES.map(([id, description], index) => SkillListItemV1Schema.parse({
    skillId: id, name: id, description, revision: '1:1',
    // The first three were in use before (migrated with their rules); the rest wait for a choice.
    rules: index < 3
      ? [{ id: `${id}-on`, skillId: id, target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }]
      : [],
    trust: 'text_only', cost: { descriptionTokens: 20, bodyTokens: 600 + index * 90 },
    provenance: { kind: 'written' }, modified: false, updatePolicy: 'manual', createdAt: 1,
    migratedFromContext: index < 3, userInvocable: true, folderId: null,
  }));
}

const noop = () => {};
const DAY = 86_400_000;

/** `?state=updates`: one skill ready to take, one the person changed whose source changed too (lab su U). */
function updatesFixture(): Readonly<{ items: readonly SkillListItemV1[]; controller: SkillsUpdatesController }> {
  const registry = (repo: string, commit: string) => ({ kind: 'registry', registry: { sourceId: 'skills-sh', format: 'skills-sh',
    sourceUrl: `https://github.com/${repo}`, itemId: repo, ref: { kind: 'gitTree', repo, path: 'skills', commit, treeSha: commit },
    importedAt: 1 } });
  const base = { revision: '1:1', rules: [{ id: 'on', skillId: 'x', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }],
    trust: 'text_only', updatePolicy: 'manual', createdAt: 1, migratedFromContext: false, userInvocable: true, folderId: null };
  const items = [
    SkillListItemV1Schema.parse({ ...base, skillId: 'frontend-design', name: 'frontend-design',
      description: 'Distinctive, production-grade web UI that avoids the generic look.', cost: { descriptionTokens: 30, bodyTokens: 1900 },
      provenance: registry('anthropics/skills', '4f2a1c9e0b'), modified: false,
      upstream: { state: 'update_available', latest: { kind: 'gitTree', repo: 'anthropics/skills', path: 'skills', commit: '9b1e7d2f4a', treeSha: 't2' } } }),
    SkillListItemV1Schema.parse({ ...base, skillId: 'sql-migrations', name: 'sql-migrations', trust: 'runs_scripts',
      description: 'Write reversible Postgres migrations and size-check them against production.', cost: { descriptionTokens: 30, bodyTokens: 1100 },
      provenance: registry('leeroy/agent-skills', 'a91e03b77c'), modified: true,
      upstream: { state: 'update_available', latest: { kind: 'gitTree', repo: 'leeroy/agent-skills', path: 'skills', commit: 'c4d2e10b9a', treeSha: 't3' } } }),
  ];
  const lines = (extra: string) => `# sql-migrations\n\nRun scripts/check_size.py on every migration.\n${extra}\nName files YYYYMMDD_short_name.sql.\n`;
  const fe = (body: string) => `# frontend-design\n\nPick a bold aesthetic direction before writing code.\n${body}\nCheck contrast in light and dark.\n`;
  const diffs = new Map<string, SkillUpdateDiffState>([
    ['frontend-design', { status: 'ready' as const, revision: '1:1', diff: { costDelta: { mine: { descriptionTokens: 30, bodyTokens: 1870 }, theirs: { descriptionTokens: 30, bodyTokens: 1970 } },
      files: [{ path: 'SKILL.md', mine: skillTextFile('SKILL.md', fe('Use one accent colour.\nAvoid default system fonts.')),
        theirs: skillTextFile('SKILL.md', fe('Use one accent colour, sampled from the product.\nAvoid default system fonts and stock gradients.\nPrefer real copy to lorem ipsum.')), changed: true }] } }],
    ['sql-migrations', { status: 'ready' as const, revision: '1:1', diff: { costDelta: { mine: { descriptionTokens: 30, bodyTokens: 1080 }, theirs: { descriptionTokens: 30, bodyTokens: 1120 } },
      files: [
        { path: 'SKILL.md', mine: skillTextFile('SKILL.md', lines('Warn above 2 GB, stop above 20 GB.\nAlways write the down migration first.')),
          theirs: skillTextFile('SKILL.md', lines('Warn above 1 GB, stop above 10 GB, and say why.\nPrefer additive changes; drop columns in a later release.')), changed: true },
        { path: 'scripts/check_size.py', mine: null, theirs: skillTextFile('scripts/check_size.py', 'import sys\n\ndef main():\n    print(sys.argv)\n', 0o755), changed: true },
        { path: 'reference.md', mine: skillTextFile('reference.md', 'Same.\n'), theirs: skillTextFile('reference.md', 'Same.\n'), changed: false },
      ] } }],
  ]);
  return { items, controller: { ready: true, check: { checking: false, checkedAt: Date.now() - 4 * 60_000, failed: false, code: null, results: [] },
    checkNow: async () => {}, diffs, loadDiff: async () => {}, applies: new Map(), apply: async () => {} } as SkillsUpdatesController };
}

/** `?state=choose`: first run with three migrated skills on and nine waiting; two were used recently. */
function ChooseFixture() {
  const items = React.useMemo(() => firstVisitItems().map((item, index) =>
    index === 4 ? { ...item, lastUsedAt: Date.now() - 3 * DAY } : index === 6 ? { ...item, lastUsedAt: Date.now() - 9 * DAY } : item), []);
  const selection = React.useMemo(() => buildSkillsFirstRunSelection(items), [items]);
  const [picked, setPicked] = React.useState<ReadonlyMap<string, boolean>>(new Map());
  const selectedIds = selection.items.filter((item) => picked.get(item.skillId) ?? selection.preselectedIds.includes(item.skillId)).map((item) => item.skillId);
  const firstRun = { eligible: true, firstVisit: { on: 3, off: 9 }, items: selection.items, migrated: items.slice(0, 3), selectedIds,
    selectedCount: selectedIds.length, setSelected: (id: string, value: boolean) => setPicked((previous) => new Map(previous).set(id, value)),
    turnOn: async () => false, notNow: noop, pending: false, errorCode: null } as unknown as SkillsFirstRun;
  const library: SkillsLibrary = { scope: null, status: 'ready', items, stale: false, errorCode: null, usageObservedSince: null, retry: noop };
  return <SkillsChoosePage library={library} firstRun={firstRun} />;
}

export function SkillsHomeSpecimen(props: Readonly<{ state?: string }>) {
  if (props.state === 'updates') return <UpdatesFixture />;
  if (props.state === 'choose') return <ChooseFixture />;
  if (props.state === 'shelf') return <ShelfFixture />;
  return <HomeFixture state={props.state} />;
}

/** `?state=shelf`: the registries shelf with three skills.sh cards (web reaches skills.sh only through a daemon). */
function ShelfFixture() {
  const library: SkillsLibrary = { scope: null, status: 'ready', items: firstVisitItems(), stale: false, errorCode: null, usageObservedSince: null, retry: noop };
  const card = (itemId: string, title: string, description: string, repo: string) => ({ sourceId: 'builtin:skills-sh', kind: 'skill' as const,
    itemId, title, description, links: { repository: `https://github.com/${repo}` } });
  const shelf = { sourceId: 'builtin:skills-sh', loading: false, items: [
    card('docx', 'docx', 'Create and edit Word documents, with tracked changes and comments.', 'anthropics/skills'),
    card('systematic-debugging', 'systematic-debugging', 'Never fix a symptom. Reproduce, then narrow the cause until one line explains the failure.', 'obra/superpowers'),
    card('incident-postmortem', 'incident-postmortem', 'Turn the timeline into a blameless review: what happened, what we learned, what changes.', 'acme/agent-plugins'),
  ] };
  return (
    <ItemList pageColumn="wide">
      <PageContentColumn>
        <SkillsRegistryShelf library={library} shelf={shelf} brandNew={false} />
      </PageContentColumn>
    </ItemList>
  );
}

function UpdatesFixture() {
  const fixture = React.useMemo(updatesFixture, []);
  const library: SkillsLibrary = { scope: null, status: 'ready', items: fixture.items, stale: false, errorCode: null, usageObservedSince: null, retry: noop };
  return <SkillsUpdatesPage library={library} updates={fixture.controller} />;
}

function HomeFixture(props: Readonly<{ state?: string }>) {
  const library = React.useMemo((): SkillsLibrary => {
    switch (props.state) {
      case 'error':
        return { scope: null, status: 'unavailable', items: [], stale: false, errorCode: 'skills_list_failed', usageObservedSince: null, retry: noop };
      case 'first':
        return { scope: null, status: 'ready', items: firstVisitItems(), stale: false, errorCode: null, usageObservedSince: null, retry: noop };
      default:
        return { scope: null, status: 'ready', items: [], stale: false, errorCode: null, usageObservedSince: null, retry: noop };
    }
  }, [props.state]);
  return <SkillsHomepage library={library} />;
}
