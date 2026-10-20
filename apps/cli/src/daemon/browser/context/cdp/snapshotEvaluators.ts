import type {
    BrowserContextSnapshotAxNodeV1,
    BrowserContextSnapshotInteractiveElementV1,
} from '@happier-dev/protocol';
import { synthesizeLocatorNameExpression } from '../../automation/locators';

/**
 * BA-2 combined-snapshot evaluators + parsers. The injected expressions are bounded + try/guarded so
 * a hostile or huge DOM can never throw out of the evaluator or return an unbounded dump; the parsers
 * defensively coerce the raw CDP result into the bounded protocol shapes. Context capture and
 * automation semantic snapshots share this bounded extraction owner. Full query Action results
 * use the automation bridge's query expression instead of these context budgets.
 */

export const SNAPSHOT_MAX_VISIBLE_TEXT_CHARS = 16_384;
export const SNAPSHOT_MAX_AX_NODES = 512;
export const SNAPSHOT_MAX_INTERACTIVE_ELEMENTS = 512;

const MAX_ROLE_CHARS = 128;
export const SNAPSHOT_MAX_NAME_CHARS = 256;
const MAX_SELECTOR_CHARS = 1024;

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function clampString(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.slice(0, max);
}

/**
 * Interactive-element evaluator: a bounded, structural list of actionable/landmark elements as
 * `{ role, name, selector, rect }`. The synthesized selector prefers a unique `#id`, then a
 * `[data-testid]`, else a short `:nth-of-type` ancestor path — a resilient locator an agent can act
 * on without coordinates. `name` is the visible accessible label (metadata), never field values;
 * `rect` is layout geometry only. Count + selector length are capped in-page.
 */
export function interactiveElementsExpression(maxElements: number): string {
    return `(() => {
    const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s);
    const isUnique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
    const synth = (el) => {
      try {
        if (el.id) { const s = '#' + cssEsc(el.id); if (s.length <= ${MAX_SELECTOR_CHARS} && isUnique(s)) return s; }
        const tid = el.getAttribute && el.getAttribute('data-testid');
        if (tid) { const s = '[data-testid="' + tid.replace(/"/g, '\\\\"') + '"]'; if (s.length <= ${MAX_SELECTOR_CHARS} && isUnique(s)) return s; }
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1) {
          let part = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (parent) {
            const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
            if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          node = parent;
          const candidate = parts.join(' > ');
          if (candidate.length > ${MAX_SELECTOR_CHARS}) return '';
          if (isUnique(candidate)) return candidate;
        }
        return '';
      } catch { return ''; }
    };
    const out = [];
    const sel = 'a,button,input,select,textarea,[role],h1,h2,h3,[aria-label]';
    const nodes = document.querySelectorAll(sel);
    // One extra raw element is the overflow sentinel; the parser returns at most the wire cap.
    for (let i = 0; i < nodes.length && out.length < ${maxElements + 1}; i++) {
      const el = nodes[i];
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const name = ${synthesizeLocatorNameExpression('el')}.slice(0, ${SNAPSHOT_MAX_NAME_CHARS + 1});
      let rect = { x: 0, y: 0, width: 0, height: 0 };
      try {
        const r = el.getBoundingClientRect();
        rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      } catch {}
      const selector = synth(el);
      out.push({ role, name, selector, rect });
    }
    return out;
  })()`;
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function parseInteractiveElements(
    value: unknown,
    cap: number,
): Readonly<{ elements: readonly BrowserContextSnapshotInteractiveElementV1[]; truncated: boolean }> {
    if (!Array.isArray(value)) return { elements: [], truncated: false };
    const elements: BrowserContextSnapshotInteractiveElementV1[] = [];
    let metadataTruncated = false;
    for (const raw of value) {
        if (elements.length >= cap) break;
        const r = record(raw);
        if (!r) continue;
        const role = clampString(r.role, MAX_ROLE_CHARS);
        // Selectors are executable code, not display text: never return a sliced selector.
        const selector = typeof r.selector === 'string' && r.selector.trim().length <= MAX_SELECTOR_CHARS
            ? r.selector.trim()
            : undefined;
        if (!role || !selector) continue;
        const name = clampString(r.name, SNAPSHOT_MAX_NAME_CHARS);
        if (typeof r.name === 'string' && r.name.trim().length > SNAPSHOT_MAX_NAME_CHARS) metadataTruncated = true;
        const rectRecord = record(r.rect);
        const rect = {
            x: numberOr(rectRecord?.x, 0),
            y: numberOr(rectRecord?.y, 0),
            width: Math.max(0, numberOr(rectRecord?.width, 0)),
            height: Math.max(0, numberOr(rectRecord?.height, 0)),
        };
        elements.push({ role, selector, rect, ...(name ? { name } : {}) });
    }
    return { elements, truncated: metadataTruncated || value.length > elements.length };
}

function axValue(node: Record<string, unknown>, field: string): string | undefined {
    const wrapped = record(node[field]);
    return clampString(wrapped?.value, field === 'role' ? MAX_ROLE_CHARS : SNAPSHOT_MAX_NAME_CHARS);
}

function editableDomNodes(document: unknown): ReadonlyMap<number, boolean> {
    const nodes = new Map<number, boolean>();
    const root = record(record(document)?.root);
    const pending = root ? [{ node: root, editable: false, secret: false }] : [];
    while (pending.length) {
        const current = pending.pop()!;
        const { node } = current;
        const attributes = new Map<string, string>();
        if (Array.isArray(node.attributes)) {
            for (let index = 0; index + 1 < node.attributes.length; index += 2) {
                const key = node.attributes[index];
                const value = node.attributes[index + 1];
                if (typeof key === 'string' && typeof value === 'string') attributes.set(key.toLowerCase(), value);
            }
        }
        const contenteditable = attributes.get('contenteditable')?.toLowerCase();
        const editable = contenteditable === 'false' ? false
            : contenteditable === '' || contenteditable === 'true' || contenteditable === 'plaintext-only'
                ? true : current.editable;
        const type = (attributes.get('type') ?? 'text').toLowerCase();
        const secret = current.secret || type === 'password'
            || (attributes.get('autocomplete') ?? '').toLowerCase().split(/\s+/u).includes('one-time-code');
        if (typeof node.backendNodeId === 'number' && Array.isArray(node.attributes)) {
            const tag = typeof node.nodeName === 'string' ? node.nodeName.toLowerCase() : '';
            const textInput = tag === 'input' && ['text', 'search', 'email', 'url', 'tel'].includes(type);
            nodes.set(node.backendNodeId, !secret && !attributes.has('readonly') && !attributes.has('disabled')
                && (textInput || tag === 'textarea' || editable));
        }
        for (const children of [node.children, node.shadowRoots, [node.contentDocument]]) {
            if (!Array.isArray(children)) continue;
            for (const child of children) {
                const next = record(child);
                if (next) pending.push({ node: next, editable, secret });
            }
        }
    }
    return nodes;
}

/**
 * AX supplies current values; DOM metadata establishes which editable fields may disclose them.
 * Unknown metadata fails closed for values while preserving the structural snapshot. Names and
 * values share the existing per-node text budget; the node count remains bounded.
 */
export function parseAxNodes(
    value: unknown,
    cap: number,
    document?: unknown,
): Readonly<{ nodes: readonly BrowserContextSnapshotAxNodeV1[]; truncated: boolean }> {
    const raw = record(value)?.nodes;
    if (!Array.isArray(raw)) return { nodes: [], truncated: false };
    const nodes: BrowserContextSnapshotAxNodeV1[] = [];
    const editable = editableDomNodes(document);
    let considered = 0;
    let valuesTruncated = false;
    for (const entry of raw) {
        const node = record(entry);
        if (!node) continue;
        if (node.ignored === true) continue;
        const role = axValue(node, 'role');
        if (!role) continue;
        considered += 1;
        if (nodes.length >= cap) continue;
        const name = axValue(node, 'name');
        const rawValue = record(node.value)?.value;
        const isEditable = Array.isArray(node.properties) && node.properties.some((property) => {
            const entry = record(property);
            const kind = record(entry?.value)?.value;
            return entry?.name === 'editable' && (kind === 'plaintext' || kind === 'richtext');
        });
        const allowed = typeof node.backendDOMNodeId === 'number' ? editable.get(node.backendDOMNodeId) : undefined;
        const fieldValue = isEditable && allowed === true && typeof rawValue === 'string'
            ? rawValue.slice(0, SNAPSHOT_MAX_NAME_CHARS) : undefined;
        if (isEditable && typeof rawValue === 'string'
            && (allowed === undefined || (allowed && rawValue.length > SNAPSHOT_MAX_NAME_CHARS))) valuesTruncated = true;
        nodes.push({ role, ...(name ? { name } : {}), ...(fieldValue !== undefined ? { value: fieldValue } : {}) });
    }
    return { nodes, truncated: valuesTruncated || considered > nodes.length };
}
