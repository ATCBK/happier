import * as React from 'react';

/**
 * The item the person is pointing at in a capability rail (a hovered or focused row), so the homepage
 * beside it can preview that item's reach. View state only, shared by the rail and the homepage, which
 * sit in sibling panes. One store per capability collection.
 */
export function createCapabilityPreview() {
  let previewed: string | null = null;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const read = () => previewed;
  return {
    set(id: string | null): void {
      if (previewed === id) return;
      previewed = id;
      for (const listener of listeners) listener();
    },
    use(): string | null {
      return React.useSyncExternalStore(subscribe, read, read);
    },
  };
}
