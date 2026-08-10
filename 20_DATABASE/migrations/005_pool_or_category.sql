-- =============================================================
-- 005: 支出の負担先を「予算カテゴリ」か「プール」の排他選択にする
--
-- プールは予算世界の貯金箱であり、そこから出す支出は予算カテゴリを消費しない。
-- 一方で実際のお金は財布から出るため、account_id は引き続き必須。
--
--   expense / refund : (カテゴリ XOR プール) かつ 財布必須
--   income          : カテゴリ必須、プール不可、入金先必須
--   transfer        : カテゴリもプールも不可、振替元と振替先が必須
--
-- 取引0件のうちに実施する。
-- =============================================================

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'ck_entries_shape')
    ALTER TABLE dbo.entries DROP CONSTRAINT ck_entries_shape
GO

ALTER TABLE dbo.entries WITH CHECK ADD CONSTRAINT ck_entries_shape CHECK (
    (kind IN (N'expense', N'refund')
        AND account_id         IS NOT NULL
        AND counter_account_id IS NULL
        -- 負担先はどちらか一方だけ
        AND ((budget_category_id IS NOT NULL AND pool_id IS NULL)
          OR (budget_category_id IS NULL     AND pool_id IS NOT NULL)))
    OR
    (kind = N'income'
        AND budget_category_id IS NOT NULL
        AND pool_id            IS NULL
        AND account_id         IS NOT NULL
        AND counter_account_id IS NULL)
    OR
    (kind = N'transfer'
        AND budget_category_id IS NULL
        AND pool_id            IS NULL
        AND account_id         IS NOT NULL
        AND counter_account_id IS NOT NULL
        AND account_id <> counter_account_id)
)
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'005_pool_or_category')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'005_pool_or_category')
GO

SELECT name, is_disabled, is_not_trusted
  FROM sys.check_constraints
 WHERE name = 'ck_entries_shape'
GO
