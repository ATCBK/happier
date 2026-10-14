function isNativeProcessExited(message) {
    return typeof message === 'object' && message !== null
        && message.type === 'terminal-native-exited'
        && (message.code === null || Number.isInteger(message.code))
        && (message.signal === null || (typeof message.signal === 'string' && message.signal.length > 0))
        && (message.code !== null || message.signal !== null);
}

function reportNativeProcessExited(proc, code, signal) {
    const message = { type: 'terminal-native-exited', code, signal };
    if (!isNativeProcessExited(message)) return Promise.resolve();
    if (typeof proc.send !== 'function' || !proc.connected) return Promise.resolve();
    return new Promise((resolve) => {
        const failed = () => {
            proc.stderr.write('Native process exit delivery failed (native_process_exit_delivery_failed)\n');
            resolve();
        };
        try {
            proc.send(message, (error) => error ? failed() : resolve());
        } catch {
            failed();
        }
    });
}

module.exports = { isNativeProcessExited, reportNativeProcessExited };
