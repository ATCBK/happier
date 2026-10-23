import * as React from 'react';

/**
 * Which icon family the app draws with.
 *
 * This exists to make a comparison possible without a rebuild: the seam already routes every glyph
 * in the product through one component, so switching families is a single lookup rather than a
 * migration. Flip it live from the console with `__setIconFamily('hugeicons')`.
 *
 * `hugeicons` is the default under trial. It covers 229 of the app's 231 concepts and draws
 * outline only, so a `fill` request and the two concepts it has no glyph for (`backspace`,
 * `markdown-logo`) fall through to Phosphor either way — see `Icon`.
 */
export type IconFamily = 'phosphor' | 'hugeicons';

const DEFAULT_FAMILY: IconFamily = 'hugeicons';

/**
 * HugeIcons draws on a 24 grid where the stroke is a real parameter, unlike Phosphor whose weights
 * are baked per glyph. 1.5 is the library's own default and the app's lighter line (owner, 2026-10-23:
 * the UI felt busy at 2); it holds at the 14-20px sizes the app uses most. This is the knob if that
 * judgement changes; `__setIconStroke(w)` previews a value on the running app.
 */
const DEFAULT_STROKE_WIDTH = 1.5;

const listeners = new Set<() => void>();
let current: IconFamily = DEFAULT_FAMILY;
let strokeWidth = DEFAULT_STROKE_WIDTH;

function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
}

export function setIconFamily(next: IconFamily): void {
    if (next === current) return;
    current = next;
    // Every icon in the tree re-reads on the next render; this is a comparison affordance, so a
    // full-tree invalidation is exactly what we want.
    for (const listener of [...listeners]) listener();
}

export function getIconFamily(): IconFamily {
    return current;
}

export function setIconStrokeWidth(next: number): void {
    if (next === strokeWidth) return;
    strokeWidth = next;
    for (const listener of [...listeners]) listener();
}

export function getIconStrokeWidth(): number {
    return strokeWidth;
}

export function useIconStrokeWidth(): number {
    return React.useSyncExternalStore(subscribe, getIconStrokeWidth, getIconStrokeWidth);
}

export function useIconFamily(): IconFamily {
    return React.useSyncExternalStore(subscribe, getIconFamily, getIconFamily);
}

if (__DEV__) {
    // Console handle so the family can be flipped while looking at the running app.
    (globalThis as { __setIconFamily?: (family: IconFamily) => void }).__setIconFamily = setIconFamily;
    (globalThis as { __getIconFamily?: () => IconFamily }).__getIconFamily = getIconFamily;
    (globalThis as { __setIconStroke?: (w: number) => void }).__setIconStroke = setIconStrokeWidth;
}
