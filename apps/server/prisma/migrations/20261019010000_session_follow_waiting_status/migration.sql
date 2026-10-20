-- Preserve the exact accepted waiting occurrence across manager restarts.
ALTER TYPE "SessionFollowDeliveredTurnStatus" ADD VALUE 'waiting';
