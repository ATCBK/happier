import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PUBLIC_PROFILE_FIELDS_V1, type PublicProfileField, type PublicProfilePolicyV1,
  type PublicProfileSnapshotV1 } from '@happier-dev/protocol/account/publicProfile';
import { projectPublicProfile } from '@happier-dev/protocol/account/projectPublicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, type PublicProfileAppearanceV1, type PublicProfileContextV1, type PublicProfileLayoutV1,
  type PublicProfileOwnerRecordV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { DEFAULT_HOME_ATMOSPHERE, type AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';

/** The applied edition's look is a reviewed copy; only a newly chosen candidate is prepared again. */
export type PublicProfileAppearanceDraft =
  | Readonly<{ kind: 'applied' }>
  | Readonly<{ kind: 'candidate'; atmosphere: AtmospherePresentation; theme: 'auto' | 'light' | 'dark' }>;
/** The owner's private draft: consent, placement and look stay on this device until Publish or Apply. */
export type PublicProfileDraft = Readonly<{ policy: PublicProfilePolicyV1; layout: PublicProfileLayoutV1; appearance: PublicProfileAppearanceDraft }>;
export type PublicProfileDraftChanges = Readonly<{ policy: boolean; layout: boolean; appearance: boolean }>;
/** Whether an item is shared, and how many placed blocks need it to be drawn. */
export type PublicFieldPlacement = Readonly<{ shown: boolean; blocks: number }>;

export const DEFAULT_PUBLIC_PROFILE_QUERY = { period: { relative: '90days' } } as const;

const DEFAULT_CANDIDATE_ATMOSPHERE: AtmospherePresentation = {
  source: 'planet', planet: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1.atmosphere.source === 'planet'
    ? DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1.atmosphere.planet : DEFAULT_HOME_ATMOSPHERE.planet,
  picture: DEFAULT_HOME_ATMOSPHERE.picture, looks: {},
};

export function createPublicProfileDraft(record: PublicProfileOwnerRecordV1 | null, defaults: Readonly<{ layout: PublicProfileLayoutV1 }>): PublicProfileDraft {
  return {
    policy: record?.policy ?? DEFAULT_PUBLIC_PROFILE_POLICY_V1,
    layout: record?.layout ?? defaults.layout,
    appearance: record?.appearance ? { kind: 'applied' }
      : { kind: 'candidate', atmosphere: DEFAULT_CANDIDATE_ATMOSPHERE, theme: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1.theme },
  };
}

/**
 * The presentation the Look panel edits: the candidate, or the applied planet/none look as its source
 * settings. An applied picture is a reviewed public copy without local pixels, so choosing a look
 * again starts from the default planet.
 */
export function draftLookPresentation(draft: PublicProfileDraft, applied: PublicProfileAppearanceV1 | null): AtmospherePresentation {
  if (draft.appearance.kind === 'candidate') return draft.appearance.atmosphere;
  const atmosphere = applied?.atmosphere;
  if (atmosphere?.source === 'planet') return { ...DEFAULT_CANDIDATE_ATMOSPHERE, planet: atmosphere.planet };
  if (atmosphere?.source === 'none') return { ...DEFAULT_CANDIDATE_ATMOSPHERE, source: 'none' };
  return DEFAULT_CANDIDATE_ATMOSPHERE;
}

export function setPublicProfileDraftField(draft: PublicProfileDraft, field: PublicProfileField, shown: boolean): PublicProfileDraft {
  if (draft.policy.fields[field] === shown) return draft;
  return { ...draft, policy: { ...draft.policy, fields: { ...draft.policy.fields, [field]: shown } } };
}

function samePolicy(a: PublicProfilePolicyV1, b: PublicProfilePolicyV1): boolean {
  return a.indexable === b.indexable && PUBLIC_PROFILE_FIELDS_V1.every(field => a.fields[field] === b.fields[field]);
}

/** What Publish or Apply would send; an untouched member keeps the server's current value. */
export function resolvePublicProfileDraftChanges(record: PublicProfileOwnerRecordV1 | null, draft: PublicProfileDraft): PublicProfileDraftChanges {
  return {
    policy: !record?.policy || !samePolicy(record.policy, draft.policy),
    layout: !record?.layout || JSON.stringify(record.layout) !== JSON.stringify(draft.layout),
    appearance: draft.appearance.kind === 'candidate',
  };
}

function shownBlocks(input: Readonly<{ context: PublicProfileContextV1; snapshot: PublicProfileSnapshotV1; layout: PublicProfileLayoutV1 }>,
  policy: PublicProfilePolicyV1): ReadonlySet<string> {
  const view = projectPublicProfile({ context: input.context, policy, metadata: {}, snapshot: input.snapshot, layout: input.layout,
    appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 });
  return new Set(view?.layout.items.flatMap(item => item.kind === 'widget' ? [item.id] : item.children.map(child => child.id)) ?? []);
}

/**
 * Asks the one disclosure projector, field by field, which placed blocks appear only while that item
 * is shared. Placement never decides consent; this only explains it.
 */
export function resolvePublicFieldPlacements(input: Readonly<{ context: PublicProfileContextV1; snapshot: PublicProfileSnapshotV1;
  draft: PublicProfileDraft }>): Readonly<Record<PublicProfileField, PublicFieldPlacement>> {
  const base = { context: input.context, snapshot: input.snapshot, layout: input.draft.layout };
  const policy = input.draft.policy;
  return Object.fromEntries(PUBLIC_PROFILE_FIELDS_V1.map(field => {
    const on = shownBlocks(base, { ...policy, fields: { ...policy.fields, [field]: true } });
    const off = shownBlocks(base, { ...policy, fields: { ...policy.fields, [field]: false } });
    return [field, { shown: policy.fields[field], blocks: [...on].filter(id => !off.has(id)).length }];
  })) as Record<PublicProfileField, PublicFieldPlacement>;
}
