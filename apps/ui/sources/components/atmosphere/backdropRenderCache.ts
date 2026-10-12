export function createBackdropRenderCache<T>(render: (key: string) => Promise<T>) {
    const jobs = new Map<string, Promise<T>>();
    return {
        render(key: string) {
            let job = jobs.get(key);
            if (!job) {
                job = render(key).catch(error => { if (jobs.get(key) === job) jobs.delete(key); throw error; });
                jobs.set(key, job);
            }
            return job;
        },
        clear() { jobs.clear(); },
    };
}
