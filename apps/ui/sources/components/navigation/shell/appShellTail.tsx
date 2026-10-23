import * as React from 'react';
import { Platform } from 'react-native';

import { requireReactDOM } from '@/utils/web/reactDomCjs';

export type AppShellRightPanelPlacement = 'canvas' | 'sheet';

/**
 * The shell's trailing slot (calm-shell R4-2), resolved once by `AppShellMaterialFrame`. With the
 * `canvas` placement a page's docked right panel and its action rail stand in these hosts, on the
 * navigation canvas beside the page sheet, mirroring the left column; with `sheet` they stay inside
 * the page and the tail is only the window's inset. `containerWidthPx` is the width the page sheet
 * has when the tail is empty, so a pane host budgets the same layout in both placements.
 */
export type AppShellTail = Readonly<{
  placement: AppShellRightPanelPlacement;
  rightHost: HTMLElement | null;
  railHost: HTMLElement | null;
  containerWidthPx: number | null;
}>;

export const AppShellTailContext = React.createContext<AppShellTail | null>(
  null,
);

/** The frame's tail, or null outside the app shell and inside a pane host that already took it. */
export function useAppShellTail(): AppShellTail | null {
  return React.useContext(AppShellTailContext);
}

/**
 * Renders its children in `host` (a tail host) when one is given, otherwise where it stands. The
 * children live in one stable container for the slot's whole life, and only that container moves
 * between the two places, so a move never remounts them: drafts, focus owners and React state stay.
 * While `hidden` (a scope that is not on screen) the container keeps its place in the tail but takes
 * no room and shows nothing. Web only; native shells always keep the page placement.
 */
export function AppShellTailSlot(
  props: Readonly<{
    host: HTMLElement | null;
    hidden?: boolean;
    children: React.ReactNode;
  }>,
): React.ReactNode {
  const [container] = React.useState<HTMLDivElement | null>(() =>
    Platform.OS === 'web' && typeof document !== 'undefined'
      ? createSlotContainer()
      : null,
  );
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  const { host, hidden } = props;
  const place = React.useCallback(() => {
    if (!container) return;
    const target = host ?? anchorRef.current;
    if (target && container.parentNode !== target)
      target.appendChild(container);
    container.style.display = host && hidden ? 'none' : 'contents';
  }, [container, hidden, host]);
  // The anchor comes before the portal, so it places the container before the children's own layout
  // effects measure anything.
  const attachAnchor = React.useCallback(
    (node: HTMLDivElement | null) => {
      anchorRef.current = node;
      place();
    },
    [place],
  );
  React.useLayoutEffect(place, [place]);
  React.useEffect(
    () => () => {
      container?.remove();
    },
    [container],
  );
  if (!container) return props.children;
  const reactDom = requireReactDOM() as Pick<
    typeof import('react-dom'),
    'createPortal'
  >;
  return (
    <>
      <div ref={attachAnchor} style={SLOT_STYLE} />
      {reactDom.createPortal(props.children, container)}
    </>
  );
}

const SLOT_STYLE = { display: 'contents' } as const;

function createSlotContainer(): HTMLDivElement {
  const node = document.createElement('div');
  node.style.display = 'contents';
  return node;
}
