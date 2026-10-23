import { useEffect, useRef, useState, useCallback } from 'react';

export type UseSearchError = 'searchFailed';
export type SearchRequestContext = Readonly<{
    isCurrent: () => boolean;
    /** Withdraw cached answers for this source when it authoritatively refuses access. */
    invalidateCache: () => void;
}>;

type SearchState<T> = {
    scopeKey: string;
    results: T[];
    isSearching: boolean;
    error: UseSearchError | null;
};

/**
 * Production-ready search hook with automatic debouncing, caching, and retry logic.
 * 
 * Features:
 * - Ignores superseded responses when the query changes or is retried
 * - Permanent in-memory cache for the lifetime of the component
 * - Automatic retry on errors with exponential backoff
 * - 300ms debounce to reduce API calls
 * - Returns cached results immediately if available
 * 
 * @param query - The search query string
 * @param searchFn - The async function to perform the search
 * @param scopeKey - The identity of the source whose query answers may be reused
 * @param enabled - Whether this source currently authorizes search and retained answers
 * @returns Object with results array, isSearching boolean, and a stable error code (if any)
 */
export function useSearch<T>(
    query: string,
    searchFn: (query: string, context: SearchRequestContext) => Promise<T[]>,
    scopeKey = '',
    enabled = true,
): { results: T[]; isSearching: boolean; error: UseSearchError | null; retry: () => void } {
    const [state, setState] = useState<SearchState<T>>({ scopeKey, results: [], isSearching: false, error: null });
    
    // Permanent cache for search results
    const cacheRef = useRef<Map<string, T[]>>(new Map());
    const requestIdRef = useRef(0);
    
    // Timeout ref for debouncing
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearScopeCache = useCallback(() => {
        const prefix = JSON.stringify([scopeKey]).slice(0, -1) + ',';
        for (const key of cacheRef.current.keys()) {
            if (key.startsWith(prefix)) cacheRef.current.delete(key);
        }
    }, [scopeKey]);
    
    // Perform the search with retry logic
    const performSearch = useCallback(async (searchQuery: string) => {
        if (!enabled) return;
        // Check cache first
        const cacheKey = JSON.stringify([scopeKey, searchQuery]);
        const cached = cacheRef.current.get(cacheKey);
        if (cached) {
            setState({ scopeKey, results: cached, isSearching: false, error: null });
            return;
        }
        
        const requestId = ++requestIdRef.current;
        const isCurrent = () => requestIdRef.current === requestId;
        setState(previous => ({
            scopeKey,
            results: previous.scopeKey === scopeKey ? previous.results : [],
            isSearching: true,
            error: null,
        }));
        
        // IMPORTANT: do not retry forever. Persistent errors (bad auth/config) would otherwise
        // cause infinite background requests and a "stuck loading" UI.
        const maxAttempts = 2;
        let attempt = 0;
        let retryDelay = 750; // Start with 0.75s
        try {
            while (attempt < maxAttempts) {
                // If a new search started, abandon this one.
                if (requestIdRef.current !== requestId) {
                    return;
                }
                attempt++;
            try {
                const searchResults = await searchFn(searchQuery, {
                    isCurrent,
                    invalidateCache: () => { if (isCurrent()) clearScopeCache(); },
                });
                if (!isCurrent()) return;
                
                // Cache the results
                cacheRef.current.set(cacheKey, searchResults);
                
                // Update state
                setState({ scopeKey, results: searchResults, isSearching: true, error: null });
                return; // Success
                
            } catch (error) {
                if (!isCurrent()) return;
                if (attempt >= maxAttempts) {
                    setState(previous => ({ scopeKey,
                        results: previous.scopeKey === scopeKey ? previous.results : [],
                        isSearching: true, error: 'searchFailed' }));
                    return;
                }
                // Wait before retrying (bounded)
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                retryDelay = Math.min(retryDelay * 2, 5000);
            }
            }
        } finally {
            if (requestIdRef.current === requestId) {
                setState(previous => ({ ...previous, isSearching: false }));
            }
        }
    }, [searchFn, scopeKey, enabled, clearScopeCache]);
    
    // Effect to handle debounced search
    useEffect(() => {
        // Invalidate the previous request before returning cached data or waiting
        // for the next debounce, including when the query was cleared.
        requestIdRef.current++;
        // Clear previous timeout
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }
        
        if (!enabled) {
            clearScopeCache();
            setState({ scopeKey, results: [], isSearching: false, error: null });
            return;
        }

        // If query is empty, clear results immediately
        if (!query.trim()) {
            setState({ scopeKey, results: [], isSearching: false, error: null });
            return;
        }
        
        // Check cache immediately
        const cached = cacheRef.current.get(JSON.stringify([scopeKey, query]));
        if (cached) {
            setState({ scopeKey, results: cached, isSearching: false, error: null });
            return;
        }
        
        // Set searching state immediately for better UX
        setState(previous => ({
            scopeKey,
            results: previous.scopeKey === scopeKey ? previous.results : [],
            isSearching: true,
            error: null,
        }));
        
        // Debounce the actual search
        timeoutRef.current = setTimeout(() => {
            performSearch(query);
        }, 300); // Hardcoded 300ms debounce
        
        // Cleanup
        return () => {
            requestIdRef.current++;
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, [query, performSearch, scopeKey, enabled, clearScopeCache]);
    
    const retry = useCallback(() => {
        if (!enabled || !query.trim()) return;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        cacheRef.current.delete(JSON.stringify([scopeKey, query]));
        void performSearch(query);
    }, [performSearch, query, scopeKey, enabled]);

    // A changed source must never render the previous source's answer before the effect runs.
    const currentScope = enabled && state.scopeKey === scopeKey;
    return {
        results: currentScope ? state.results : [],
        isSearching: currentScope ? state.isSearching : enabled && query.trim().length > 0,
        error: currentScope ? state.error : null,
        retry,
    };
}
