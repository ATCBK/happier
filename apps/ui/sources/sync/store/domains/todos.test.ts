import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createTodosDomain, type TodosDomain } from './todos';

describe('todos publication', () => {
    it('retains equal snapshots and publishes version/readiness changes', () => {
        const store = createStore<TodosDomain>()((set, get) => createTodosDomain({ set, get }));
        const snapshot = { todos: {}, undoneOrder: [], doneOrder: [], versions: { index: 1 } };
        const notify = vi.fn();
        const unsubscribe = store.subscribe(notify);
        store.getState().applyTodos(snapshot);
        expect(store.getState().todosLoaded).toBe(true);
        expect(notify).toHaveBeenCalledTimes(1);
        const before = store.getState();
        store.getState().applyTodos(structuredClone(snapshot));
        expect(store.getState()).toBe(before);
        expect(notify).toHaveBeenCalledTimes(1);
        store.getState().applyTodos({ ...structuredClone(snapshot), versions: { index: 2 } });
        expect(store.getState().todoState?.undoneOrder).toBe(snapshot.undoneOrder);
        expect(store.getState().todoState?.todos).toBe(snapshot.todos);
        expect(store.getState().todoState?.versions.index).toBe(2);
        expect(notify).toHaveBeenCalledTimes(2);
        unsubscribe();
    });
});
