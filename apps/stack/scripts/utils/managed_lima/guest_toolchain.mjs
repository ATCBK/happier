// Bootstrap/dispatch metadata must not load the Lima execution adapter.
export const REQUIRED_MANAGED_LIMA_GUEST_TOOLCHAIN = Object.freeze([
  Object.freeze({ command: 'node', label: 'Node.js' }),
  Object.freeze({ command: 'npm', label: 'npm' }),
  Object.freeze({ command: 'rg', label: 'ripgrep (rg)' }),
]);
