export type PromptModalityV1 = 'coding' | 'voice';

export type PromptBlockScopeV1 =
  | 'session'
  | 'first_turn'
  | 'turn'
  | 'provider_behavior'
  | 'tool_delivery'
  | 'user_prompt'
  | 'bootstrap';

export type PromptBlockV1 = Readonly<{
  id: string;
  scope: PromptBlockScopeV1;
  text: string;
  enabled?: boolean;
}>;

export type PromptPlanV1 = Readonly<{
  modality: PromptModalityV1;
  blocks: readonly PromptBlockV1[];
}>;

function normalizePromptBlock(block: PromptBlockV1): PromptBlockV1 | null {
  if (!block || typeof block !== 'object') return null;
  if (block.enabled === false) return null;
  const id = typeof block.id === 'string' ? block.id.trim() : '';
  const text = typeof block.text === 'string' ? block.text.trim() : '';
  if (!id || !text) return null;
  return {
    id,
    scope: block.scope,
    text,
  };
}

export function dedupePromptBlocksV1(blocks: ReadonlyArray<PromptBlockV1 | null | undefined>): PromptBlockV1[] {
  const out: PromptBlockV1[] = [];
  const seen = new Set<string>();

  for (const candidate of blocks) {
    if (!candidate) continue;
    const normalized = normalizePromptBlock(candidate);
    if (!normalized) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }

  return out;
}

export function buildPromptPlanV1(args: Readonly<{
  modality: PromptModalityV1;
  blocks: ReadonlyArray<PromptBlockV1 | null | undefined>;
}>): PromptPlanV1 {
  return {
    modality: args.modality,
    blocks: dedupePromptBlocksV1(args.blocks),
  };
}

export function renderPromptBlocksV1(blocks: ReadonlyArray<PromptBlockV1 | null | undefined>): string {
  return dedupePromptBlocksV1(blocks)
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

export function renderPromptPlanV1(plan: PromptPlanV1): string {
  return renderPromptBlocksV1(plan.blocks);
}

/** Render a host plan for delivery into a native Agent's user input. */
export function renderSessionInputPromptPlanV1(plan: PromptPlanV1): string {
  const text = renderPromptPlanV1(plan);
  if (!text) return text;
  // Native Agents can echo the entire prepared plan into a user record. Keep
  // its display boundary with this producer, including dynamic plugin assets.
  // Preparation normalizes to NFC; measure after that normalization as well.
  const normalized = text.normalize('NFC');
  return `<happier_coding_prompt length="${normalized.length}">\n${normalized}\n</happier_coding_prompt>`;
}

/** A frame delimits bytes; only the injecting owner's reproduced content may be hidden. */
export function readLeadingCodingPromptPlanV1(text: string, isInjectedContent: (content: string) => boolean = () => false): string | null {
  const header = text.match(/^\s*<happier_coding_prompt length="(\d+)">\n/);
  if (!header) return null;
  const length = Number(header[1]);
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const end = header[0].length + length;
  const closing = '\n</happier_coding_prompt>';
  if (end > text.length || !text.startsWith(closing, end)) return null;
  if (!isInjectedContent(text.slice(header[0].length, end))) return null;
  const remaining = text.slice(end + closing.length);
  return remaining === '' || /^\s/.test(remaining) ? remaining.trimStart() : null;
}

export function buildPromptPlanDiagnosticsV1(plan: PromptPlanV1): Readonly<{
  modality: PromptModalityV1;
  blockIds: string[];
  scopes: PromptBlockScopeV1[];
}> {
  return {
    modality: plan.modality,
    blockIds: plan.blocks.map((block) => block.id),
    scopes: plan.blocks.map((block) => block.scope),
  };
}
