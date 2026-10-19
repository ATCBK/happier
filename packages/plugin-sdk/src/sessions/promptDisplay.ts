/** @moduleRealm daemon */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readSessionInputPromptUserTextV1 as readBaseUserText } from '@happier-dev/protocol/prompts/systemPromptBaseV1';
import { createExternalSessionContentMatchSnippet as createSnippet } from '@happier-dev/protocol/sessions/external/contentSearchMatch';

// Like the SDK's SCM services, this display-only host binding must survive
// separately bundled SDK copies without becoming a process-wide reader choice.
const storageKey = Symbol.for('happier.pluginSdk.sessions.promptDisplayReader');
const globalScope = globalThis as typeof globalThis & Record<symbol, unknown>;
const existing = globalScope[storageKey];
const readers = existing instanceof AsyncLocalStorage
  ? existing as AsyncLocalStorage<(text: string) => string>
  : new AsyncLocalStorage<(text: string) => string>();
globalScope[storageKey] = readers;

/** Scope the host's installed-catalog inverse to one native read invocation. */
export function runWithSessionInputPromptUserTextReader<T>(reader: (text: string) => string, operation: () => T): T {
  return readers.run(reader, operation);
}

export function readSessionInputPromptUserTextV1(text: string): string {
  return (readers.getStore() ?? readBaseUserText)(text);
}

export function createExternalSessionContentMatchSnippet(text: string, query: string): string | null {
  // Prefer clean presentation, but a hidden prefix is still searchable input.
  return createSnippet(readSessionInputPromptUserTextV1(text), query) ?? createSnippet(text, query);
}
