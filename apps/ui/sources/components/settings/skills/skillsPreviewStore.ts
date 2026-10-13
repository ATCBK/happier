import * as React from 'react';

/**
 * The skill the person is pointing at (a hovered or focused rail row): the homepage's map lights its
 * dots and the legend says who gets it. View state only, shared by the rail and the homepage, which
 * sit in sibling panes.
 */
let previewed: string | null = null;
const listeners = new Set<() => void>();

export function setPreviewedSkill(skillId: string | null): void {
  if (previewed === skillId) return;
  previewed = skillId;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => previewed;

export function usePreviewedSkill(): string | null {
  return React.useSyncExternalStore(subscribe, read, read);
}
