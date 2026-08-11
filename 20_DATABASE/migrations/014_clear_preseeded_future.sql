-- ===============================================================
-- 014: 先に入ってしまった翌月以降の既定配分を取り消す
--
-- 013 までの作りでは、翌月の予算ページを開いた時点で既定額が
-- 配分として入っていた（budgets.ts の ensurePeriod）。
--
-- 翌月は「月を締めて初めて決まる」ようにしたため、この行が残っていると
--   ・締める前なのに翌月が確定して見える
--   ・締めたときに既定額（reason = 'default'）が重ねて入り、二重になる
-- という2つの問題が起きる。
--
-- 消すのは機械が入れた行だけに限る。次の3つをすべて満たすものに絞る。
--   1. reason = 'initial' かつ note = N'既定の予算から'（自動投入の印）
--   2. 今月より後の月（今月以前の実績には触れない）
--   3. その月に取引が1件も無く、締められていない
-- ===============================================================

DECLARE @today DATE = CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC'
                            AT TIME ZONE 'Tokyo Standard Time' AS DATE);
DECLARE @thisMonth CHAR(7) = CONVERT(CHAR(7), @today, 126);

-- 消す前に対象を出しておく（記録として残す）
SELECT ba.id, ba.household_id, ba.year_month, c.name AS category_name, ba.amount
  FROM dbo.budget_allocations ba
  JOIN dbo.budget_categories c ON c.id = ba.category_id
 WHERE ba.reason = 'initial'
   AND ba.note = N'既定の予算から'
   AND ba.year_month > @thisMonth
   AND NOT EXISTS (
         SELECT 1 FROM dbo.entries e
          WHERE e.household_id = ba.household_id
            AND e.is_deleted = 0
            AND CONVERT(CHAR(7), e.entry_date, 126) = ba.year_month)
   AND NOT EXISTS (
         SELECT 1 FROM dbo.budget_periods p
          WHERE p.household_id = ba.household_id
            AND p.year_month = ba.year_month
            AND p.status = N'closed')
 ORDER BY ba.id;

DELETE ba
  FROM dbo.budget_allocations ba
 WHERE ba.reason = 'initial'
   AND ba.note = N'既定の予算から'
   AND ba.year_month > @thisMonth
   AND NOT EXISTS (
         SELECT 1 FROM dbo.entries e
          WHERE e.household_id = ba.household_id
            AND e.is_deleted = 0
            AND CONVERT(CHAR(7), e.entry_date, 126) = ba.year_month)
   AND NOT EXISTS (
         SELECT 1 FROM dbo.budget_periods p
          WHERE p.household_id = ba.household_id
            AND p.year_month = ba.year_month
            AND p.status = N'closed');

SELECT @@ROWCOUNT AS 取り消した行数;
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'014_clear_preseeded_future')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'014_clear_preseeded_future')
GO

SELECT year_month, reason, COUNT(*) AS 行数, SUM(amount) AS 合計
  FROM dbo.budget_allocations
 GROUP BY year_month, reason
 ORDER BY year_month, reason
GO
