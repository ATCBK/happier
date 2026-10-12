export function darwinKeepAwakeInvocation(mode: 'on' | 'on_power', daemonPid: number) {
    return { command: '/usr/bin/caffeinate', args: [mode === 'on' ? '-im' : '-s', '-w', String(daemonPid)] };
}
