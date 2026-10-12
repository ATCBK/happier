# Design labs: how to get premium results

This is the method behind the lab rounds the user rated best: the Home index, Homes journeys and Channels
(2026-09-28). The standalone contact sheet they replaced (`homes-journeys.html`) was rejected, even though
its product thinking was sound. The difference was the method, not the designer.

## The rules

1. **Build inside the standard lab format, in the feature's own lab folder.** Every lab uses the same
   shared kit: chrome, variant picker, light/dark toggle, notes, shell helpers and shot scripts. The kit
   lives in `.happier/design-lab/settings/` and `.happier/design-lab/app-surfaces/`.
   - A new feature, program or plan gets its own folder, `.happier/design-lab/<feature>/`. Its small
     `index.html` loads the shared kit and the shared lab host, plus only that feature's `screens-*.js`
     and CSS. Its shots go in its own `shots/` folder.
   - Don't append new features to `app-surfaces/index.html`. It already loads every past concept and has
     become too crowded to review. Extend an existing concept page only when refining that same concept.
   - Draw frames inside the shell as it ships (rail, columns, panes), reusing the shared shell helpers
     instead of redrawing them.
   - Never make a one-off page or contact sheet. The user compares concepts side by side, and a different
     format reads as a lesser design.
2. **Product truth before pixels.** Before drawing, read the real owner: the manifest, data model, routes,
   states and actions, and for a plugin its `src/**` and docs.
   - Design only what the system can back.
   - Tag anything that needs new data or capability as `new` and list it.
   - Report every doc/code mismatch you find.
   - An invented activity feed, unread counts or a mute that doesn't exist makes a beautiful frame that
     can't ship.
3. **Quote the user, bind the decisions.** The brief carries the user's own words and every ratified
   decision.
   - Address every point the user raised, one by one.
   - Where the user asked a question ("maybe X, or Y?"), render the options as variants and recommend
     one, with the reason.
4. **Fewest frames that decide the design.**
   - One frame per decision.
   - Every desktop variant gets a 390 phone twin, and every frame renders in light and dark at 1440 and
     390.
   - No filler frames.
5. **Populated, realistic data.** Use real-looking names, numbers, times, statuses and mixed states:
   working, needs you, failed, stale. A lab with three "Lorem" rows hides every density and hierarchy
   problem.
6. **Every state, not just the happy path.** Show fresh, loading, stale (showing cached data, refreshing),
   empty (explains what the surface is for and offers the next action), error with its recovery, and
   offline. Show these for each new surface or widget.
7. **The lab consumes the design system.** Reuse the approved primitives: row metrics, 32px segmented and
   search controls, popovers, the flat settings-sidebar column, pane headers, the empty-state composition.
   A lab that invents new chrome fails even when it looks good, because it can't be built through the
   owners.
8. **Load the taste layers.** Load this skill and `references/premium-feel.md` first, and run its
   self-check on every frame. Then load `make-interfaces-feel-better` and
   `interface-details` (Claude Code skills; a lane that cannot load them is not a lab or composition
   lane). Describe motion (morphs, drag, expansion) in the notes if the lab can't prototype
   it.
9. **A fixed output contract.**
   - The rationale for each frame.
   - The capability gaps (`new`).
   - At most 3 open questions, each with a recommended default.
   - A final message of 10 lines or fewer: the lab path, the concept ids, one recommendation per question.
10. **Design lanes design; build lanes build.** A lab lane never edits product source. Implementation
    lanes consume the approved frames and are validated side by side against them
    (`references/validation.md`).
11. **The orchestrator looks before the user does.** Open the rendered shots and check them against rules
    1–7. Reject any format drift before presenting.

12. **Each chosen scene gets a short spec**, a few lines in its notes:
    - the content column width and gutters;
    - how it behaves at 1440, 1920, 2560 and 390;
    - long and heavy content;
    - its states;
    - the motion intent.

    Draw on the product's roles, so the lab is built at the scale it was drawn. From the repo root,
    run `node apps/ui/scripts/exportDesignLabTokens.mjs` to refresh
    `.happier/design-lab/_shared/product-tokens.css` from the current light/dark web themes and the
    scale owners: the type roles (`HAPPIER_TYPE_SCALE`: `display`, `title`, `heading`, `label`,
    `reading`, `body`, `meta`, `micro`), the spacing steps (`theme.space`, `s2` to `s48`) and the
    layout roles (`HAPPIER_PAGE_METRICS`). The shared kit (`settings/lab.css`, `settings/craft.css`,
    `app-surfaces/app.css`) imports it and holds no type or spacing number of its own:
    - Text takes a role: `font-size: var(--product-type-body-size)` with
      `line-height: var(--product-type-body-line)` (and `-weight`, `-tracking`), or the `.t-body`
      class. Another weight is an emphasis (`var(--product-font-weights-semi-bold)`), never a number.
      `var(--product-type-face-default)` and `var(--product-type-face-mono)` pick the shipped static
      face by weight, as the app does.
    - Gaps and padding take a step (`var(--product-space-s12)`); frames take layout roles
      (`--product-page-column-reading`, `--product-page-sheet-inset-px`,
      `--product-page-section-gap-px`, `--product-page-row-min-height-px`,
      `--product-page-control-height-px`, …). Hairlines (0, 1, 3 px), negative optical offsets and
      glyphs sized to their box stay literal.
    - No half sizes and no in-between weights. When a scene needs a value no role has, propose a role
      change for every consumer, app included, in the round's report; never add a lab-only number.

    Feature lab CSS moves onto the roles when it is next touched. Serve labs from the repo root so the
    exported font-face URLs reach the app's font assets.

## Brief skeleton

```
Design-lab lane for <surface>. DESIGN LAB ONLY: no product source edits.
Read AGENTS.md, DESIGN.md, happier-ui-craft (+ references/premium-feel.md, references/design-labs.md); load make-interfaces-feel-better
and interface-details.
Study how the existing labs are built and follow exactly the same format: <lab path>.
Product truth: read <owners/plugin src/docs>; design only what exists; tag gaps `new`.
Binding decisions: <ratified list>.
The user's words: "<quote>". Address every point; where they asked a question, render variants and recommend one.
Scope: <frames/states>. Keep it lean: the fewest frames that decide.
Render light/dark at 1440/390 with the lab's shot tooling and check they render without errors.
Write rationale, `new` gaps and ≤3 open questions (each with a default) to <lanes/…-lab.md>. Final ≤ 10 lines.
Concurrent labs: use your own concept page/CSS; add your index link last as one small edit.
```
