import type {Message} from '../messages/messageTypes.js';

// Fixed-depth hash trie behind the existing enumerable Record interface. A
// revision copies seven small branches, never the transcript or old snapshots.
// Hash collisions retain exact string keys in the leaf; no row can be lost.
type Node = {children?: ReadonlyMap<number, Node>; rows?: ReadonlyMap<string, Message>};
type Key = {value: string; previous: Key | null};
type Snapshot = {root: Node; keys: Key | null};
const snapshots = new WeakMap<object, Snapshot>();

function hash(key: string): number {
    let value = 2166136261;
    for (let index = 0; index < key.length; index++) value = Math.imul(value ^ key.charCodeAt(index), 16777619);
    return value >>> 0;
}

function read(root: Node, key: string): Message | undefined {
    const code = hash(key);
    let node: Node | undefined = root;
    for (let shift = 0; shift < 32 && node; shift += 5) node = node.children?.get((code >>> shift) & 31);
    return node?.rows?.get(key);
}

function write(root: Node, key: string, value: Message): Node {
    const code = hash(key);
    const path: Array<{node: Node; slot: number}> = [];
    let node = root;
    for (let shift = 0; shift < 32; shift += 5) {
        const slot = (code >>> shift) & 31;
        path.push({node, slot});
        node = node.children?.get(slot) ?? {};
    }
    let next: Node = {rows: new Map(node.rows).set(key, value)};
    for (let index = path.length - 1; index >= 0; index--) {
        const {node: parent, slot} = path[index]!;
        next = {children: new Map(parent.children).set(slot, next)};
    }
    return next;
}

function record(snapshot: Snapshot): Record<string, Message> {
    const target: Record<string, Message> = {};
    const result = new Proxy(target, {
        get: (target, key, receiver) => typeof key === 'string'
            ? read(snapshot.root, key) ?? Reflect.get(target, key, receiver) : Reflect.get(target, key, receiver),
        has: (target, key) => typeof key === 'string' && read(snapshot.root, key) !== undefined || Reflect.has(target, key),
        ownKeys: () => {
            const keys: string[] = [];
            for (let key = snapshot.keys; key; key = key.previous) keys.push(key.value);
            // Ordinary Record enumeration puts array-index keys first.
            return keys.reverse().sort((left, right) => {
                const a = String(Number(left) >>> 0) === left && left !== '4294967295';
                const b = String(Number(right) >>> 0) === right && right !== '4294967295';
                return a && b ? Number(left) - Number(right) : a ? -1 : b ? 1 : 0;
            });
        },
        getOwnPropertyDescriptor: (_target, key) => {
            const value = typeof key === 'string' ? read(snapshot.root, key) : undefined;
            return value === undefined ? undefined : {value, enumerable: true, configurable: true, writable: false};
        },
        set: () => false,
        defineProperty: () => false,
        deleteProperty: () => false,
        preventExtensions: () => false,
    });
    snapshots.set(result, snapshot);
    return result;
}

/** Plain inputs are adopted once; subsequent updates path-copy changed rows.
 * Enumeration/serialization explicitly materializes keys, but point updates do not. */
export function patchMessageRecord(previous: Record<string, Message>, changed: readonly Message[]): Record<string, Message> {
    if (!changed.some(message => previous[message.id] !== message)) return previous;
    let snapshot = snapshots.get(previous);
    if (!snapshot) {
        snapshot = {root: {}, keys: null};
        for (const key of Object.keys(previous)) {
            snapshot.root = write(snapshot.root, key, previous[key]!);
            snapshot.keys = {value: key, previous: snapshot.keys};
        }
    }
    let root = snapshot.root;
    let keys = snapshot.keys;
    for (const message of changed) {
        const old = read(root, message.id);
        if (old === message) continue;
        if (!old) keys = {value: message.id, previous: keys};
        root = write(root, message.id, message);
    }
    return root === snapshot.root ? previous : record({root, keys});
}
