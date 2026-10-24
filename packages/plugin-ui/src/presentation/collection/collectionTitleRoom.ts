/**
 * Whether a compact control still fits beside a column's title (a view switch: Projects | Recent,
 * Definitions | Runs). The title never collapses to a letter: below its floor the control yields — to
 * View options or to the band under the title — and it returns only when the title's floor and the
 * control's measured width both fit, so a width on the boundary does not flicker. Decided on layout
 * events only, never per frame.
 */
export function resolveHappierCollectionTitleAccessoryFits(input: Readonly<{
  shown: boolean;
  titleWidth: number | null;
  accessoryWidth: number | null;
  titleFloor: number;
  gap: number;
}>): boolean {
  if (input.titleWidth === null) return input.shown;
  if (input.shown) return input.titleWidth >= input.titleFloor;
  if (input.accessoryWidth === null) return true;
  return input.titleWidth - input.accessoryWidth - input.gap >= input.titleFloor;
}
