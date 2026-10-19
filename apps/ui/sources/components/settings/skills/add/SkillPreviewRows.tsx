import * as React from 'react';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import type { CapabilityFactsProps } from '@/components/capabilities/facts/CapabilityFacts';

import { skillReferencesNote } from '../outsideReferences';

/** The preview's identity facts: where it was found, pinned. */
export function previewRef(item: SkillInstallPreviewV1): string | undefined {
  const provenance = item.provenance;
  if (provenance.kind === 'link' && provenance.ref.kind === 'gitTree')
    return provenance.ref.commit.slice(0, 7);
  if (
    provenance.kind === 'registry' &&
    provenance.registry.ref.kind === 'gitTree'
  )
    return provenance.registry.ref.commit.slice(0, 7);
  return undefined;
}

const none: ReadonlySet<string> = new Set();

/**
 * The skills a link or an upload found, one row each: ticked when `ticked` is given (the whole row is its checkbox),
 * with what each refers to under its facts, kept siblings first and the files that will not come along after.
 */
export function SkillPreviewRows(
  props: Readonly<{
    items: readonly SkillInstallPreviewV1[];
    ticked: ReadonlySet<string> | null;
    onToggle: (path: string) => void;
    facts: (item: SkillInstallPreviewV1) => CapabilityFactsProps;
    testID: string;
  }>,
) {
  const nameByPath = React.useMemo(
    () => new Map(props.items.map((item) => [item.path, item.name])),
    [props.items],
  );
  const kept = props.ticked ?? new Set(props.items.map((item) => item.path));
  return (
    <>
      {props.items.map((item) => (
        <CapabilityRow
          key={item.path}
          testID={`${props.testID}.item.${item.name}`}
          title={item.name}
          description={item.description}
          facts={props.facts(item)}
          {...(props.ticked ? { checked: props.ticked.has(item.path) } : {})}
          // A row left unticked brings no sibling along, so all it refers to counts as left behind.
          note={skillReferencesNote(item, props.ticked?.has(item.path) === false ? none : kept, nameByPath, `${props.testID}.item.${item.name}`)}
          {...(props.ticked ? { onPress: () => props.onToggle(item.path) } : {})}
        />
      ))}
    </>
  );
}
