ALTER TABLE "transactions" ADD COLUMN "original_direction" "direction";
--> statement-breakpoint
-- 手工流水的方向由用户给出，可直接保留；旧导入流水不猜测已被规则改变前的方向。
UPDATE "transactions" SET "original_direction" = "direction" WHERE "source" = 'manual' AND "original_direction" IS NULL;
