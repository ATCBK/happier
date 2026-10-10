import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';

/** Flox 1.18.1 has no service wait command: its log follower survives service exit.
 * This native activation recipe translates selected-service completion to its own
 * exit. Happier's existing managedSpawn owner retains all tree/cancellation custody.
 */
export function createFloxServiceActivationArgs(input: Readonly<{
    command: string;
    prefixArgs: readonly string[];
    root: string;
    target: string;
    observationIntervalMs: number;
}>): readonly string[] {
    const native = [input.command, ...input.prefixArgs].map(safeBashSingleQuote).join(' ');
    const service = safeBashSingleQuote(input.target);
    const script = `
service=${service}
native() { ${native} services "$@"; }
follower=
status_pattern='"status"[[:space:]]*:[[:space:]]*"([[:alpha:]]+)"'
exit_pattern='"exit_code"[[:space:]]*:[[:space:]]*([0-9]+)'
observation=$(native status --json "$service") || exit "$?"
if [[ "$observation" =~ $status_pattern ]]; then
    case "\${BASH_REMATCH[1]}" in
        Stopped|Completed|Error|Disabled) ;;
        *) printf 'Selected Flox service is already active; refusing borrowed custody\\n' >&2; exit 1 ;;
    esac
else
    exit 1
fi
cleanup() {
    trap - EXIT
    native stop "$service"
    if test -n "$follower"; then
        kill "$follower" 2>/dev/null || true
        wait "$follower" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
native start "$service" || exit "$?"
native logs --follow "$service" &
follower=$!
for ((;;)); do
    observation=$(native status --json "$service") || exit "$?"
    # The installed CLI emits one JSON-array entry for this exact selected name.
    # Read only its machine-owned scalar fields, never eval native output.
    if [[ "$observation" =~ $status_pattern ]]; then
        phase=\${BASH_REMATCH[1]}
    else
        exit 1
    fi
    case "$phase" in
        Running|Starting|Restarting|Pending|Launched)
            sleep ${input.observationIntervalMs / 1000} & wait "$!"
            ;;
        Completed|Stopped|Error)
            native logs "$service"
            if [[ "$observation" =~ $exit_pattern ]]; then
                exit "\${BASH_REMATCH[1]}"
            fi
            test "$phase" != Error
            exit "$?"
            ;;
        *) exit 1 ;;
    esac
done`;
    return [...input.prefixArgs, 'activate', '--dir', input.root, '--no-start-services', '-c', script];
}
