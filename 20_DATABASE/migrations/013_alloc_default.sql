-- ===============================================================
-- 013: 締めが作る既定予算の理由を足す
--
-- 翌月の予算は、月を締めて初めて決まるようにする。
-- そのとき設定の既定額から入れる行を 'default' として区別する。
--
-- 区別する理由は「締めを戻す」ため。
-- 締めが作った行だけを消したいので、利用者が手で入れた
-- 'initial' / 'adjust' と混ぜてはいけない。
--
-- あわせて、予算タブでの読み分けにも使う。
--   基準額（母数） = initial + carry_over + default
--   調整           = adjust + transfer + to_pool + from_pool
-- ===============================================================

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'ck_alloc_reason')
    ALTER TABLE dbo.budget_allocations DROP CONSTRAINT ck_alloc_reason
GO

ALTER TABLE dbo.budget_allocations WITH CHECK
    ADD CONSTRAINT ck_alloc_reason CHECK (reason IN
        (N'initial', N'default', N'transfer', N'to_pool', N'from_pool',
         N'carry_over', N'carry_to_pool', N'adjust', N'reversal'))
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'013_alloc_default')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'013_alloc_default')
GO

SELECT name, is_disabled, is_not_trusted
  FROM sys.check_constraints
 WHERE name = 'ck_alloc_reason'
GO
