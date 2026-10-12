import { z } from 'zod';

import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const CLIPBOARD_ACTION_IDS = ['clipboard.write'] as const;
export const ClipboardWriteInputSchema = z.object({ text: z.string() }).strict();
export const ClipboardWriteResultSchema = z.object({ status: z.literal('copied') }).strict();

export const CLIPBOARD_ACTION_SPECS = [{
  id: 'clipboard.write', approval: {result: 'required'},
  title: 'Copy text to this device',
  description: 'Write exact supplied text to the answering client’s clipboard. Refuses when that client or its clipboard is unavailable.',
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
  placements: [], bindings: { mcpToolName: 'clipboard_write' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  cli: { acceptsServerId: true, commands: [{ path: ['clipboard', 'write'], visibility: 'canonical' }] },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: ClipboardWriteInputSchema, outputSchema: ClipboardWriteResultSchema,
  // Copied diagnostics and user text belong to the clipboard, not shared observation records.
  approvalInputCustody: 'live_only',
  projectObservationInput: () => ({}),
  approvalPresentation: { summary: () => 'Copy text to the answering device clipboard. The copied content stays private to this live invocation.' },
  inputHints: { fields: [{ path: 'text', title: 'Text to copy', widget: 'text', required: true }] },
}] as const satisfies readonly PreNormalizedActionSpec[];
