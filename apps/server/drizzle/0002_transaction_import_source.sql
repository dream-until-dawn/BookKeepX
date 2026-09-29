ALTER TABLE "transactions" ADD COLUMN "import_source" text;
--> statement-breakpoint
-- 单号来源明确的旧流水可安全回填。
UPDATE "transactions" SET "import_source" = "external_source" WHERE "external_source" IS NOT NULL AND "import_source" IS NULL;
--> statement-breakpoint
-- 无单号的内置模板来源也可确定；旧自定义模板可能已删除或变更，不猜测。
UPDATE "transactions" AS t SET "import_source" = CASE b."template_id"
  WHEN 'cmb-pdf' THEN 'cmb' WHEN 'alipay-csv' THEN 'alipay' WHEN 'wechat-xlsx' THEN 'wechat' END
FROM "import_batches" AS b
WHERE t."import_batch_id" = b."id" AND t."ledger_id" = b."ledger_id"
  AND t."import_source" IS NULL AND b."template_id" IN ('cmb-pdf', 'alipay-csv', 'wechat-xlsx');
