-- Keep ciphertext opaque and change only retired plaintext Account mentions.
WITH parts AS (
    SELECT message."id", message."content", part.key, part.fullkey, part.value,
        CASE WHEN part.type = 'object' THEN
            json_extract(part.value, '$.t') = 'mention'
                AND json_type(part.value, '$.accountId') = 'text'
                AND json_type(part.value, '$.participant') IS NULL
            ELSE 0 END AS legacy
    FROM "DiscussionMessage" AS message, json_each(CASE
        WHEN json_extract(message."content", '$.t') = 'plain'
            AND json_extract(message."content", '$.v.v') = 1
            AND json_type(message."content", '$.v.parts') = 'array'
        THEN message."content" ELSE '{"v":{"parts":[]}}' END, '$.v.parts') AS part
), converted AS (
    SELECT "id", json_group_array(json(CASE WHEN legacy THEN
        json_set(json_remove(value, '$.accountId'), '$.participant',
            json_object('kind', 'account', 'accountId', json_extract(value, '$.accountId')))
        ELSE "content" -> fullkey END) ORDER BY CAST(key AS INTEGER)) AS value
    FROM parts GROUP BY "id" HAVING MAX(legacy) = 1
)
UPDATE "DiscussionMessage" SET "content" = json_set("content", '$.v.parts',
    json((SELECT value FROM converted WHERE converted."id" = "DiscussionMessage"."id")))
WHERE "id" IN (SELECT "id" FROM converted);
