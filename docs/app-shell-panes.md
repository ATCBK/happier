# App shell panes

This page describes the unreleased 0.3 shell contracts under integration. The shell keeps a page's main content,
side panel, details workspace and bottom pane under one scoped owner. The left navigation column
has its own visibility owner; hiding a page's main column does not collapse navigation.

## Owners and callers

- `apps/ui/sources/components/appShell/panes/model/appPaneReducer.ts` owns scoped pane state.
  `AppPaneProvider` persists it in the device-local `appPaneScopesV1` setting.
- `AppPaneScopeHost` is the composition boundary for Sessions, Projects, Workflows and app pages.
  It resolves effective main visibility and arrangement once, then supplies `PaneColumnsHost`.
  `AppScopePaneHost`, `DetailsPaneHost` and `DetailsPaneSlotHost` forward destination-owned data.
- `components/ui/panels/paneBreakpoints.ts#resolvePaneLayout` owns docked/overlay decisions.
  Callers inside a pane host consume its live layout rather than interpreting window width again.
- `panes/layout/paneSizing.ts` owns pane sizing roles. `SidebarNavigator` and `sidebarSizing.ts`
  own the independent navigation column.
- Plugin UI's `presentation/layout/resize` owns resize math, pointer reading and the accessible
  handle. Host pane adapters, SplitCanvas and collection rails consume this owner.

## Main column visibility

A host offers hide/show by supplying `mainColumn: { hideLabel, showLabel, identity }`.
The destination supplies its own name, mark and existing lifecycle presentation; the shell does
not infer a Session or Workflow state from a scope id. A host without this descriptor offers no
hide control. Session and Project headers supply their domain wording; app pages use their title.

`PaneScopeState.mainHidden` is a persisted preference, changed by the `setMainHidden` reducer
action. `usePaneMainColumn()` exposes the host's effective `hidden`, `canHide`, `folded`,
labels, identity and `setHidden`/`toggle` controls to descendants. It returns null outside a host.
An active presentation outside the host's descendant context, such as Session presentation intents, receives the same
measured controls through `onMainColumnControlsChange` and calls their `setHidden`. This also opens
a folded main drawer whose persisted flag may already be false; dispatching the persisted flag alone
cannot reveal that drawer. Explicit focus or return-to-Chat reports unavailable without published
controls. Ordinary Board opening beside Chat and item reveal retain their scoped pane navigation
when no main-column host is present, without creating a visibility fallback.

`AppPaneScopeHost` only hides main when the layout supports neighbouring content and a side or
details column is available. It clears stale hide state when the last neighbouring column closes,
including destination-owned details not represented in the reducer. A narrow single-column layout
keeps its usable main surface. The hidden main remains mounted through `RetainedPanelSurface`;
composer drafts, editor state, scroll and embedded browser identity survive hide/show.

`AgentInput` owns the shared composer-focus request used by keyboard commands, registered composer
targets and review handoffs. A request reveals hidden main through these published controls, then
focuses the retained field after the visible layout commits. An unpresented composer refuses the
request. Review handoffs separately close panes and select mobile Chat without sending or clearing
the review tabs; they do not own another visibility setter.

The visible main header owns the hide button. Once hidden, a restore chip in the neighbouring
column retains the destination's identity and current lifecycle presentation. The old route-bound
pane focus mode and its details-header controls are retired. Protocol presentation vocabulary stays
unchanged: `board.open` with `mode: 'focus'` hides main, `beside_chat` reveals it, and `chat.return`
reveals it while preserving the person's open panes. Item reveal preserves visibility.
The local-settings normalizer still removes the obsolete `editorFocusModeEnabled` input key;
that cleanup-only reader has no visibility control or current writer.

## Arrangement and geometry

The device-local `paneArrangement` setting selects Session first or Editor first. Session and
Project hosts opt in with `arrangement="honour"`; Workflows and app pages retain Session-first
order. Phones do not apply arrangement controls. The setting is exposed through the declared
`appearance.paneArrangement` Settings anchor.

Editor first makes details/editor flexible and retains an editor column even before a file opens.
The Session column has a remembered pixel width; the side panel folds first, then main becomes a
drawer when its minimum cannot fit. The layout resolver decides these transitions. `row-reverse`
and one `mirrored` fact change physical placement without reordering or re-parenting content.

Stored pixels are preferences; rendered pixels are clamped to the available pane budget. Window
changes, folding and hiding never write a clamped or zero width back to a preference. The navigation
column's default comes from the standard collection-rail role and does not grow with the window.
The local-settings normalizer migrates the former pixel/basis pairs once: old defaults at their old
basis become unset, other pixel preferences remain, and the basis keys are removed.

Every resizable column shares Plugin UI's resize primitive. Collapse is opt-in: navigation arms
only when attempted size passes half its minimum, and commits collapse on release. Passing slightly
below minimum only clamps. Other pane and collection rails do not opt into collapse. Double-click
resets through the owning column's default; geometry and persistence stay with that owner.

## Shell planes, right panel position and pane headers

`AppShellMaterialFrame` owns the shell's planes. The rail, title strip and navigation column stand on
one canvas plane (`appShellColumnSurface`, colour from `appShellColumnPlaneColor`); only the page is a
lifted, rounded sheet, with no outline and no column hairline. The page's seam shadow is an inert sibling
of the sheet inside the page slot, so it follows the column's drawn width (drag, rubber band, spring-back,
collapse) through ordinary layout. A peeked column floats in a body overlay right after the rail.
Settings and Home console columns use the same plane.

The device-local `rightPanelPlacement` setting (`canvas` default, `sheet`; anchor
`appearance.rightPanelPlacement`, set from Appearance and the Look panel, agents via `settings.set`)
chooses where a page's docked right panel and its action rail stand. `SidebarNavigator` reads it once;
the frame resolves it (`sheet` without chrome and off the web) and publishes the tail hosts and the
page's empty-tail width through `appShellTail.tsx`. `PaneColumnsHost` stands the docked right column and
the rail in the tail only for the one page on screen at the trailing edge (not Editor first, not one pane
of a split) and budgets its layout with the empty-tail width, so both placements resolve the same widths.
`AppShellTailSlot` keeps one container per column, so changing places moves it without remounting.
Overlay, in-main and hidden presentations and the details drawers stay in the page. On the canvas the
column, rail and their headers and lists take the plane's paint.

`PaneHeader` owns the pane header band (title, identity, facts, Back, close, an optional overline and a
phone navigation band); `DetailsTabHeader` is the one adaptive content/fit adapter over it, used by Session
(`SessionPaneHeader`, the data leaf), Discussion and the Details tabs. Entity headers pass
`actionsFit="compact"`: their controls stay beside the title and read the header's one fit result,
`DetailsTabHeaderActionsCompactContext`. Headers draw no bottom hairline; a scroll-linked shade appears
instead. `PaneHeaderScrollScope` pairs one header with its primary body; the body's scroller reports its
physical distance from the top (the shared transcript renderer, `ItemList`, a plugin `ScrollArea` through
the private presentation-host hook) and the shade's opacity is that distance over 12 px. Side panes, the
bottom pane and popovers are isolated from the main scope; outside a scope a header draws no shade.

## Openers and Actions

Openers request a destination kind through the existing pane adapter. An implicit open does not
move an already-open tab. Details retain their existing preview/pinned and split-workspace owners.

`shell.column.get/set` address `navigation` (the default), `main` or `side`; `tab` on a side-panel
set selects an existing built-in or plugin tab and opens that panel. Main visibility uses the inverse
of `mainHidden`. Arrangement uses `settings.get/set` on its declared anchor. Widths remain continuous
geometry controls rather than Actions. These reversible view Actions retain their existing default
approval policy; per-Action user settings still apply. See [Actions](actions.md).

Resizable collection widths and presentation-host bindings are documented in
[Collection presentation](collection-presentation.md); installed-plugin ownership is described in
[Plugin platform](plugin-platform.md).
