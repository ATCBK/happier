import { PromptStacksV1Schema } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { resolvePromptStackSystemAppendBlocksV1 as resolvePromptStackSystemAppendBlocksProtocolV1, type PromptStackSystemAppendInputV1, type PromptStackSystemAppendResultV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';

export async function resolvePromptStackSystemAppendBlocksV1(
  args: Omit<PromptStackSystemAppendInputV1, 'promptStacksV1'> & Readonly<{ promptStacksV1?: unknown }>,
): Promise<PromptStackSystemAppendResultV1> {
  const { promptStacksV1, ...input } = args;
  return resolvePromptStackSystemAppendBlocksProtocolV1({
    ...input,
    ...(promptStacksV1 === undefined ? {} : { promptStacksV1: PromptStacksV1Schema.parse(promptStacksV1) }),
  });
}
