-- ===============================================================
-- 016: 合計に含めない印
--
-- 「その他」のような受け皿や、性質の違う口座（証券など）が合計に混ざると、
-- 財布の合計や予算の合計が実感と合わなくなる。
--
-- アーカイブとは別物にする。
--   アーカイブ  … もう使わない。一覧から消えて選べなくなる
--   この印      … 使うけれど数えない。一覧にも出るし記録でも選べる
-- 混ぜると「使いたいのに隠れる」か「数えたくないのに数えられる」になる。
-- ===============================================================

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('dbo.accounts') AND name = 'exclude_from_totals'
)
ALTER TABLE dbo.accounts ADD exclude_from_totals BIT NOT NULL
    CONSTRAINT df_acc_exclude DEFAULT 0
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('dbo.budget_categories') AND name = 'exclude_from_totals'
)
ALTER TABLE dbo.budget_categories ADD exclude_from_totals BIT NOT NULL
    CONSTRAINT df_cat_exclude DEFAULT 0
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'016_exclude_from_totals')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'016_exclude_from_totals')
GO

SELECT 'accounts' AS 対象, COUNT(*) AS 件数,
       SUM(CAST(exclude_from_totals AS INT)) AS 除外済み
  FROM dbo.accounts WHERE household_id = 1
UNION ALL
SELECT 'categories', COUNT(*), SUM(CAST(exclude_from_totals AS INT))
  FROM dbo.budget_categories WHERE household_id = 1
GO
