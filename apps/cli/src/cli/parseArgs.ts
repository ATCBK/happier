import { parseAndStripTerminalRuntimeFlags, type TerminalRuntimeFlags } from '../terminal/runtime/terminalRuntimeFlags';
import { parseRuntimeContextPrefixArgs } from '../utils/env/runtimeContextArgv';
import { normalizeCliArgv } from './processArgs';

export { normalizeCliArgv, readCliProcessArgs } from './processArgs';

export function parseCliArgs(argv: string[]): Readonly<{
  args: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
}> {
  const { args } = parseRuntimeContextPrefixArgs(normalizeCliArgv(argv));
  const parsed = parseAndStripTerminalRuntimeFlags(args);
  return { args: parsed.argv, terminalRuntime: parsed.terminal };
}
