import type { TodoState } from '../../domains/todos/todoOps';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import type { StoreGet, StoreSet } from './_shared';

export type TodosDomain = {
    todoState: TodoState | null;
    todosLoaded: boolean;
    applyTodos: (todoState: TodoState) => void;
};

export function createTodosDomain<S extends TodosDomain>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): TodosDomain {
    return {
        todoState: null,
        todosLoaded: false,
        applyTodos: (todoState) =>
            set((state) => {
                const previous = state.todoState;
                if (sameStrictJsonValue(previous, todoState)) return state.todosLoaded ? state : { ...state, todosLoaded: true };
                if (!previous) return { ...state, todoState, todosLoaded: true };
                const todos = sameStrictJsonValue(previous.todos, todoState.todos) ? previous.todos
                    : Object.fromEntries(Object.entries(todoState.todos).map(([id, todo]) => [id,
                        sameStrictJsonValue(previous.todos[id], todo) ? previous.todos[id]! : todo]));
                return { ...state, todosLoaded: true, todoState: { ...todoState, todos,
                    undoneOrder: sameStrictJsonValue(previous.undoneOrder, todoState.undoneOrder) ? previous.undoneOrder : todoState.undoneOrder,
                    doneOrder: sameStrictJsonValue(previous.doneOrder, todoState.doneOrder) ? previous.doneOrder : todoState.doneOrder,
                    versions: sameStrictJsonValue(previous.versions, todoState.versions) ? previous.versions : todoState.versions,
                } };
            }),
    };
}

