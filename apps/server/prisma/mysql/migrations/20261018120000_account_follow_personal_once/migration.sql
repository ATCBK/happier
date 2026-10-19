ALTER TABLE `AccountSessionFollow` ADD COLUMN `followPolicy` LONGTEXT NULL;
ALTER TABLE `AccountSessionFollow` ADD COLUMN `notifyOnce` LONGTEXT NULL;
ALTER TABLE `AccountSessionFollow` ADD COLUMN `hasPersistentFollow` BOOLEAN NOT NULL DEFAULT true;
