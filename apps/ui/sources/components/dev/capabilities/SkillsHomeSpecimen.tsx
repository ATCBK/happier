import * as React from 'react';
import { SkillListItemV1Schema, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { SkillsHomepage } from '@/components/settings/skills/SkillsHomepage';
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

export function SkillsHomeSpecimen(props: Readonly<{ state?: string }>) {
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
