-- Preserve the exact accepted waiting occurrence across manager restarts.
ALTER TABLE `SessionFollowEdge` MODIFY `deliveredTurnStatus` ENUM('completed', 'failed', 'cancelled', 'waiting') NULL;
