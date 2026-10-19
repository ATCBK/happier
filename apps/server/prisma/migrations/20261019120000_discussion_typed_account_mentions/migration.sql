-- Convert only the retired plaintext Account-mention arm. Encrypted envelopes
-- and retry-equality evidence remain opaque and unchanged.
WITH parts AS (
    SELECT message."id", part.value, part.ordinality,
        part.value->>'t' = 'mention'
            AND jsonb_typeof(part.value->'accountId') = 'string'
            AND NOT (part.value ? 'participant') AS legacy
    FROM "DiscussionMessage" AS message
    CROSS JOIN LATERAL jsonb_array_elements(CASE
        WHEN message."content"->>'t' = 'plain'
            AND message."content"#>'{v,v}' = '1'::jsonb
            AND jsonb_typeof(message."content"#>'{v,parts}') = 'array'
        THEN message."content"#>'{v,parts}' ELSE '[]'::jsonb END)
        WITH ORDINALITY AS part(value, ordinality)
), converted AS (
    SELECT "id", jsonb_agg(CASE WHEN legacy THEN
        jsonb_set(value - 'accountId', '{participant}',
            jsonb_build_object('kind', 'account', 'accountId', value->'accountId'))
        ELSE value END ORDER BY ordinality) AS value
    FROM parts GROUP BY "id" HAVING bool_or(legacy)
)
UPDATE "DiscussionMessage" AS message
SET "content" = jsonb_set(message."content", '{v,parts}', converted.value)
FROM converted WHERE message."id" = converted."id";
