# Droid schema 2 fixture

Unmodified public sanitized fixture from
[rimio-ai/rimz@897b1e367f3f954bba6e197b2392b1e82f3c327a](https://github.com/rimio-ai/rimz/blob/897b1e367f3f954bba6e197b2392b1e82f3c327a/crates/rimz/src/agents/adapters/droid/tests/fixtures/droid-0.170.0-transcript-v2.jsonl).
The upstream adapter documents observed native Droid 0.170.0/0.171.0 schema 2,
parent-linked active history, hook messages, and visibility filtering. Its fixture
also includes deliberate malformed and future records. Capture provenance is
upstream's claim; this checkout has not run an installed Droid to certify it.

The older stream-json dialect in upstream is not a versioned session-store contract.
It is reported unsupported rather than folded into this schema 2 decoder.
