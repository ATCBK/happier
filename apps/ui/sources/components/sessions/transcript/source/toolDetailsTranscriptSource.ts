import type { SessionTranscriptSource } from './types';

/** A tool-detail transcript keeps result navigation while refusing another nested message-detail page. */
export function toolDetailsTranscriptSource(source: SessionTranscriptSource): SessionTranscriptSource {
    const navigate = source.navigate;
    return {
        ...source,
        navigate: navigate ? href => {
            const pathname = href.split(/[?#]/, 1)[0] ?? '';
            if (/^\/session\/[^/]+\/message\/[^/]+\/?$/.test(pathname)) return;
            navigate(href);
        } : null,
    };
}
