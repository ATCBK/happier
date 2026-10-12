import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  AgentExecutionRunOpenRequest,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH } from './adapter.js';
import { readOpenCodeConfigPart, type OpenCodeConfigPart } from '../runtime/server/opencodeConfigContent.js';

export async function readOpenCodeProviderConfigPart(
  request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest,
): Promise<OpenCodeConfigPart | undefined> {
  const materialization = request.providerBinding?.materialization;
  if (materialization === undefined) return undefined;
  if (
    materialization.kind !== 'configFile'
    || materialization.relativePaths.length !== 1
    || materialization.relativePaths[0] !== OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH
  ) {
    throw new Error('OpenCode Provider binding requires its canonical config-file materialization');
  }
  return readOpenCodeConfigPart(await readFile(
    join(materialization.rootPath, OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH),
    'utf8',
  ));
}
