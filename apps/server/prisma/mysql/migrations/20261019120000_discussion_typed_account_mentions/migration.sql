-- Ordered window aggregation preserves every part and avoids GROUP_CONCAT's
-- truncation boundary. Only retired plaintext Account mentions are rewritten.
WITH parts AS (
    SELECT message.`id`, ordinal.position,
        JSON_EXTRACT(message.`content`, CONCAT('$.v.parts[', ordinal.position - 1, ']')) AS part
    FROM `DiscussionMessage` AS message
    JOIN JSON_TABLE(CASE
        WHEN JSON_UNQUOTE(JSON_EXTRACT(message.`content`, '$.t')) = 'plain'
            AND JSON_EXTRACT(message.`content`, '$.v.v') = CAST('1' AS JSON)
            AND JSON_TYPE(JSON_EXTRACT(message.`content`, '$.v.parts')) = 'ARRAY'
        THEN JSON_EXTRACT(message.`content`, '$.v.parts') ELSE JSON_ARRAY() END,
        '$[*]' COLUMNS (position FOR ORDINALITY)) AS ordinal
), classified AS (
    SELECT *, JSON_UNQUOTE(JSON_EXTRACT(part, '$.t')) = 'mention'
        AND JSON_TYPE(JSON_EXTRACT(part, '$.accountId')) = 'STRING'
        AND JSON_CONTAINS_PATH(part, 'one', '$.participant') = 0 AS legacy
    FROM parts
), converted AS (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `id` ORDER BY position) AS row_number_in_message,
        MAX(legacy) OVER (PARTITION BY `id`) AS has_legacy,
        JSON_ARRAYAGG(CAST(CASE WHEN legacy THEN
            JSON_SET(JSON_REMOVE(part, '$.accountId'), '$.participant',
                JSON_OBJECT('kind', 'account', 'accountId', JSON_EXTRACT(part, '$.accountId')))
            ELSE part END AS JSON)) OVER (PARTITION BY `id` ORDER BY position
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS value
    FROM classified
)
UPDATE `DiscussionMessage` AS message JOIN converted ON message.`id` = converted.`id`
SET message.`content` = JSON_SET(message.`content`, '$.v.parts', converted.value)
WHERE converted.row_number_in_message = 1 AND converted.has_legacy = 1;
