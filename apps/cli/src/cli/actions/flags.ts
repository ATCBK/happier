
export const ACTION_CLI_HELP_FLAGS = Object.freeze(['--help', '-h'] as const);

export const ACTION_CLI_JSON_OUTPUT_FLAG = '--json' as const;

export const ACTION_CLI_WHOLE_INPUT_FLAG = '--input-json' as const;

export const ACTION_CLI_MACHINE_ID_FLAG = '--machine-id' as const;

export const ACTION_CLI_SERVER_ID_FLAG = '--server-id' as const;

export const ACTION_CLI_REQUEST_ID_FLAG = '--request-id' as const;

export const ACTION_CLI_GLOBAL_FLAGS: readonly string[] = Object.freeze([
  ...ACTION_CLI_HELP_FLAGS,
  ACTION_CLI_JSON_OUTPUT_FLAG,
]);

export const ACTION_CLI_COMPILER_OWNED_FLAGS: readonly string[] = Object.freeze([
  ...ACTION_CLI_GLOBAL_FLAGS,
  ACTION_CLI_WHOLE_INPUT_FLAG,
]);

