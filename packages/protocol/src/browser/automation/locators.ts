/** The browser locator grammar shared by automation and human-facing action references. */
export type ParsedLocator =
  | Readonly<{ strategy: 'role'; role: string; name?: string }>
  | Readonly<{ strategy: 'text'; text: string }>
  | Readonly<{ strategy: 'testid'; testId: string }>
  | Readonly<{ strategy: 'css'; selector: string }>;

/** Self-contained so the installed collector executes the same parser as managed Chromium. */
export function parseLocator(rawInput: string | ParsedLocator): ParsedLocator {
  if (typeof rawInput !== 'string') return rawInput;
  const ROLE_NAME_PATTERN = /^([A-Za-z][\w-]*)(?:\[name=(?:"([^"]*)"|'([^']*)'|([^\]]*))\])?$/u;
  const input = rawInput.trim();
  const roleBody = input.startsWith('role=') ? input.slice(5) : null;
  if (roleBody !== null) {
    const match = ROLE_NAME_PATTERN.exec(roleBody.trim());
    if (match) {
      const name = match[2] ?? match[3] ?? match[4];
      return name !== undefined && name.length > 0
        ? { strategy: 'role', role: match[1].toLowerCase(), name }
        : { strategy: 'role', role: match[1].toLowerCase() };
    }
    return { strategy: 'role', role: roleBody.trim().toLowerCase() };
  }
  const text = input.startsWith('text=');
  let body: string | null = null;
  if (text) body = input.slice(5);
  else if (input.startsWith('data-testid=')) body = input.slice(12);
  else if (input.startsWith('testid=')) body = input.slice(7);
  if (body !== null) {
    let value = body.trim();
    const first = value[0], last = value[value.length - 1];
    if (value.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) value = value.slice(1, -1);
    return text ? { strategy: 'text', text: value } : { strategy: 'testid', testId: value };
  }
  return { strategy: 'css', selector: input };
}

/** Normalize the retained structured input at the boundary, never the Action's field value. */
export function normalizeBrowserAutomationLocator(payload: Readonly<Record<string, unknown>>): ParsedLocator | null {
  const input = payload.locator ?? payload.selector;
  if (typeof input === 'string') return input.trim() ? parseLocator(input) : null;
  const locator = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Readonly<Record<string, unknown>>
    : payload;
  const kind = locator.kind ?? locator.type;
  const value = locator.selector ?? locator.value ?? locator.text ?? locator.testId ?? locator.role;
  if (typeof value !== 'string' || !value.trim()) return null;
  switch (kind) {
    case 'css':
    case 'selector': return { strategy: 'css', selector: value };
    case 'text': return { strategy: 'text', text: value };
    case 'testId':
    case 'testid': return { strategy: 'testid', testId: value };
    case 'role': return { strategy: 'role', role: value.toLowerCase(),
      ...(typeof locator.name === 'string' ? { name: locator.name } : {}) };
    default:
      // Retain explicit structured selectors without turning type/setValue's content into a target.
      if (kind === undefined && locator !== payload) {
        if (typeof locator.text === 'string') return { strategy: 'text', text: locator.text };
        if (typeof locator.testId === 'string') return { strategy: 'testid', testId: locator.testId };
        return parseLocator(value);
      }
      return null;
  }
}

/** Browser-safe, self-contained resolution shared by CDP expressions and the installed collector. */
export function resolveBrowserLocatorElements(locator: ParsedLocator, page: Pick<Document, 'querySelectorAll'>): Element[] {
  // Methods keep this function serializable even when a source runner preserves function names.
  const names = { read(element: Element) { return (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/gu, ' ').trim(); } };
  try {
    if (locator.strategy === 'css') return Array.from(page.querySelectorAll(locator.selector));
    if (locator.strategy === 'testid') {
      return Array.from(page.querySelectorAll('[data-testid]')).filter(element => element.getAttribute('data-testid') === locator.testId);
    }
    const elements = Array.from(page.querySelectorAll('*'));
    if (locator.strategy === 'text') {
      const structural = new Set(['html', 'body', 'head', 'script', 'style', 'noscript']);
      const needle = locator.text;
      const matching = { read(element: Element) { return !structural.has(element.tagName.toLowerCase()) && names.read(element).includes(needle); } };
      return elements.filter(element => {
        if (!matching.read(element)) return false;
        const descendants = Array.from(element.children ?? []);
        while (descendants.length > 0) {
          const child = descendants.shift()!;
          if (matching.read(child)) return false;
          descendants.push(...Array.from(child.children ?? []));
        }
        return true;
      });
    }
    const implicit: Readonly<Record<string, string>> = { a: 'link', button: 'button', input: 'textbox', textarea: 'textbox',
      select: 'combobox', h1: 'heading', h2: 'heading', h3: 'heading', nav: 'navigation' };
    return elements.filter(element => {
      const tag = element.tagName.toLowerCase();
      return (element.getAttribute('role') || implicit[tag] || tag).toLowerCase() === locator.role
        && (locator.name === undefined || names.read(element) === locator.name);
    });
  } catch {
    return [];
  }
}
