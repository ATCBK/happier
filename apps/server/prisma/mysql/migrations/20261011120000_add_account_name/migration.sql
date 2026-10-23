ALTER TABLE `Account` ADD COLUMN `name` TEXT NULL;

-- Match String.trim() for retained profile parts; preserve their original bytes.
-- Use the same explicit collation for stored text and connection-built patterns.
UPDATE `Account`
SET `name` = NULLIF(CONCAT_WS(' ',
    NULLIF(REGEXP_REPLACE(COALESCE(`firstName`, '') COLLATE utf8mb4_bin,
        CONCAT('^[', CONVERT(0x090a0b0c0d20c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf USING utf8mb4), ']+|[', CONVERT(0x090a0b0c0d20c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf USING utf8mb4), ']+$') COLLATE utf8mb4_bin,
        ''), ''),
    NULLIF(REGEXP_REPLACE(COALESCE(`lastName`, '') COLLATE utf8mb4_bin,
        CONCAT('^[', CONVERT(0x090a0b0c0d20c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf USING utf8mb4), ']+|[', CONVERT(0x090a0b0c0d20c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf USING utf8mb4), ']+$') COLLATE utf8mb4_bin,
        ''), '')
), '');
