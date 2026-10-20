import { realpath } from 'node:fs/promises';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';
import { resolveGeminiDirForEnv } from '../../../connectedServices/chatSessionFiles.js';

export async function resolveGeminiSource(source: AgentExternalSessionSource): Promise<AgentExternalSessionSource & { configDir: string }> {
  if (source.kind !== 'geminiConfigDir') throw new Error('Gemini source kind is unsupported');
  const configDir = typeof source.configDir === 'string' && source.configDir.trim()
    ? source.configDir : resolveGeminiDirForEnv(process.env);
  return { kind: 'geminiConfigDir', configDir: await realpath(configDir) };
}
