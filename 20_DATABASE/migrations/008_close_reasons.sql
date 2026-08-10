-- ===============================================================
-- 008: 月次締めが作った「余りをプールへ」を専用の理由で区別する
--
-- 締めを戻すときは、締めが作った行だけを取り消す必要がある。
-- 利用者が予算画面から手で拠出した to_pool と同じ理由を使っていると、
-- 取り消しのときに手動の拠出まで巻き込んで消してしまう。
--
-- carry_to_pool を追加し、締めが作った行はこれで印を付ける。
-- ===============================================================

ALTER TABLE dbo.budget_allocations DROP CONSTRAINT ck_alloc_reason
GO

ALTER TABLE dbo.budget_allocations WITH CHECK
    ADD CONSTRAINT ck_alloc_reason CHECK (reason IN
        (N'initial', N'transfer', N'to_pool', N'from_pool',
         N'carry_over', N'carry_to_pool', N'adjust', N'reversal'))
GO

ALTER TABLE dbo.pool_movements DROP CONSTRAINT ck_pmov_reason
GO

ALTER TABLE dbo.pool_movements WITH CHECK
    ADD CONSTRAINT ck_pmov_reason CHECK (reason IN
        (N'from_budget', N'to_budget', N'external_in', N'external_out',
         N'carry_to_pool', N'direct_spend', N'adjust', N'reversal'))
GO
