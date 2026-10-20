/**
 * BA-3: semantic locators for the agent automation path.
 *
 * Beyond raw CSS / coordinates, the agent can target elements by resilient semantics:
 *  - `role=<role>[name="<accessible name>"]` — ARIA role + optional accessible-name match
 *  - `text=<substring>`                       — visible-text substring match
 *  - `data-testid=<id>` / `testid=<id>`       — test-id attribute match
 *  - any other string                          — treated as a raw CSS selector
 *
 * The module is intentionally framework-free (no Playwright launch). It exposes:
 * Protocol owns `parseLocator`, the grammar shared with transcript references. This module owns:
 *  - `resolveLocator` — resolve a descriptor against a minimal DOM model (deterministic, testable
 *    without a browser/jsdom) used by unit tests and any in-process resolution
 *  - `synthesizeLocatorExpression` — emit a self-contained JS expression that resolves the locator
 *    to a CSS-addressable element in-page, consumed by the CDP query/input transport (cdp.ts)
 *
 * The structured descriptor + the in-page expression share the SAME matching semantics so the
 * unit-tested resolver is a faithful model of the in-page behavior.
 */

import { resolveBrowserLocatorElements, type ParsedLocator } from '@happier-dev/protocol/browser/automation/locators';

/** Minimal DOM element model: enough to resolve every locator strategy deterministically. */
export type LocatorElement = Readonly<{
  tag: string;
  attributes?: Readonly<Record<string, string>>;
  text?: string;
  children?: readonly LocatorElement[];
}>;

// ARIA roles that can be inferred from a tag when no explicit `role` attribute is present. This is a
// pragmatic subset (not the full HTML-AAM) covering the elements agents target most.
const IMPLICIT_ROLE_BY_TAG: Readonly<Record<string, string>> = {
  a: 'link',
  button: 'button',
  input: 'textbox',
  textarea: 'textbox',
  select: 'combobox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  nav: 'navigation',
};

const TEXT_LOCATOR_STRUCTURAL_TAGS = ['html', 'body', 'head', 'script', 'style', 'noscript'] as const;
const TEXT_LOCATOR_STRUCTURAL_TAG_SET = new Set<string>(TEXT_LOCATOR_STRUCTURAL_TAGS);

function elementRole(element: LocatorElement): string {
  const explicit = element.attributes?.role;
  if (explicit && explicit.length > 0) return explicit.toLowerCase();
  return IMPLICIT_ROLE_BY_TAG[element.tag.toLowerCase()] ?? element.tag.toLowerCase();
}

function accessibleName(element: LocatorElement): string {
  const ariaLabel = element.attributes?.['aria-label'];
  if (ariaLabel && ariaLabel.length > 0) return ariaLabel.trim();
  return (element.text ?? '').replace(/\s+/gu, ' ').trim();
}

function textLocatorText(element: LocatorElement): string {
  return accessibleName(element);
}

function textLocatorCandidateMatches(element: LocatorElement, text: string): boolean {
  if (TEXT_LOCATOR_STRUCTURAL_TAG_SET.has(element.tag.toLowerCase())) return false;
  return textLocatorText(element).includes(text);
}

function descendantTextLocatorCandidateMatches(element: LocatorElement, text: string): boolean {
  for (const child of element.children ?? []) {
    if (textLocatorCandidateMatches(child, text) || descendantTextLocatorCandidateMatches(child, text)) {
      return true;
    }
  }
  return false;
}

function matchesTextLocator(element: LocatorElement, text: string): boolean {
  return textLocatorCandidateMatches(element, text)
    && !descendantTextLocatorCandidateMatches(element, text);
}

function flatten(root: LocatorElement): LocatorElement[] {
  const out: LocatorElement[] = [root];
  for (const child of root.children ?? []) {
    out.push(...flatten(child));
  }
  return out;
}

function matchesCss(element: LocatorElement, selector: string): boolean {
  const trimmed = selector.trim();
  if (trimmed.startsWith('#')) {
    return element.attributes?.id === trimmed.slice(1);
  }
  if (trimmed.startsWith('.')) {
    const className = element.attributes?.class ?? '';
    return className.split(/\s+/u).includes(trimmed.slice(1));
  }
  const attrMatch = /^([A-Za-z][\w-]*)?\[([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\]]*))\]$/u.exec(trimmed);
  if (attrMatch) {
    const [, tag, attr, dq, sq, bare] = attrMatch;
    const expected = dq ?? sq ?? bare ?? '';
    const tagOk = !tag || element.tag.toLowerCase() === tag.toLowerCase();
    return tagOk && element.attributes?.[attr] === expected;
  }
  return element.tag.toLowerCase() === trimmed.toLowerCase();
}

/**
 * Resolve a parsed locator against a minimal DOM model. Returns the first matching element in
 * document order, or null when nothing matches. This is the deterministic model of the in-page
 * `synthesizeLocatorExpression` resolution.
 */
export function resolveLocator(locator: ParsedLocator, root: LocatorElement): LocatorElement | null {
  const elements = flatten(root);
  switch (locator.strategy) {
    case 'role':
      return elements.find((element) =>
        elementRole(element) === locator.role
        && (locator.name === undefined || accessibleName(element) === locator.name),
      ) ?? null;
    case 'text':
      return elements.find((element) => matchesTextLocator(element, locator.text)) ?? null;
    case 'testid':
      return elements.find((element) =>
        element.attributes?.['data-testid'] === locator.testId,
      ) ?? null;
    case 'css':
      return elements.find((element) => matchesCss(element, locator.selector)) ?? null;
    default:
      return null;
  }
}

/**
 * Emit a self-contained JS expression that resolves the locator in-page and returns the matched
 * element's bounding-box center + a synthesized stable selector, or null. Consumed by the CDP
 * query/input transport. Read-only: it never carries field values back.
 */
export function synthesizeLocatorExpression(locator: ParsedLocator): string {
  return resolveExpression(synthesizeLocatorElementExpression(locator));
}

/** Shared page-realm label extraction; response owners apply their wire projection afterwards. */
export function synthesizeLocatorNameExpression(element: string): string {
  return `(${element}.getAttribute('aria-label') || ${element}.textContent || '').replace(/\\s+/g, ' ').trim()`;
}

export function synthesizeLocatorElementExpression(locator: ParsedLocator): string {
  return `(${synthesizeLocatorElementsExpression(locator)}[0] || null)`;
}

export function synthesizeLocatorElementsExpression(locator: ParsedLocator): string {
  return `(${resolveBrowserLocatorElements.toString()})(${JSON.stringify(locator)}, document)`;
}

function resolveExpression(elementExpression: string): string {
  return `(() => {
    const el = ${elementExpression};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}
