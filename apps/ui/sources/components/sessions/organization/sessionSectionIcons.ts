import type { IconName } from '@/components/ui/icons/Icon';

/** A section without a chosen icon leads with the section lines (lab `lsSection`). */
export const SESSION_SECTION_DEFAULT_ICON: IconName = 'list';

/**
 * The icons a person can give a section (lab `clsections:custom`, Change icon). The stored value is a
 * free string an Action may also write; only names from this set are drawn, anything else keeps the
 * default lines.
 */
export const SESSION_SECTION_ICON_CHOICES: readonly IconName[] = [
  'list',
  'rocket',
  'eye',
  'star',
  'flag',
  'bug',
  'lightning',
  'target',
  'flask',
  'book',
  'heart',
  'sparkle',
];

export function resolveSessionSectionIcon(
  icon: string | null | undefined,
): IconName {
  return (
    SESSION_SECTION_ICON_CHOICES.find((choice) => choice === icon) ??
    SESSION_SECTION_DEFAULT_ICON
  );
}
