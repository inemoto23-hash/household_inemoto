-- =============================================================
-- 003: 優先表示する財布（利用者ごと）
--
-- 口座数が多く今後も増減するため、単一の「既定の財布」では足りない。
-- 利用者ごとに「よく使う財布」を複数選び、選択欄の先頭へ出す。
--
-- users.default_account_id は廃止する。
-- 「既定の財布」と「優先表示」は同じことを2通りに持つことになり、
-- 設定箇所が増えるだけで利点がないため、優先リストへ一本化する。
-- 初期選択は「優先リストのうち直近に使ったもの」で決める。
-- 冪等: 何度実行してもよい
-- =============================================================

-- ---- 優先表示テーブル ---------------------------------------
IF OBJECT_ID('dbo.user_account_priorities', 'U') IS NULL
CREATE TABLE dbo.user_account_priorities (
    id          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_user_account_priorities PRIMARY KEY,
    user_id     BIGINT       NOT NULL CONSTRAINT fk_uap_user    REFERENCES dbo.users(id),
    account_id  BIGINT       NOT NULL CONSTRAINT fk_uap_account REFERENCES dbo.accounts(id),
    created_at  DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_uap UNIQUE (user_id, account_id)
)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_uap_user')
CREATE INDEX ix_uap_user ON dbo.user_account_priorities (user_id) INCLUDE (account_id)
GO

-- ---- 既存の default_account_id を優先リストへ移してから削除 ----
IF EXISTS (
    SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.users') AND name = 'default_account_id'
)
BEGIN
    INSERT INTO dbo.user_account_priorities (user_id, account_id)
    SELECT u.id, u.default_account_id
      FROM dbo.users u
     WHERE u.default_account_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM dbo.user_account_priorities p
            WHERE p.user_id = u.id AND p.account_id = u.default_account_id
       );

    IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_users_default_account')
        ALTER TABLE dbo.users DROP CONSTRAINT fk_users_default_account;

    ALTER TABLE dbo.users DROP COLUMN default_account_id;
END
GO

-- ---- 適用記録 -----------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'003_account_priority')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'003_account_priority')
GO

-- ---- 確認 ---------------------------------------------------
SELECT COLUMN_NAME AS remaining_default_column
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'default_account_id'
GO

SELECT COUNT(*) AS priority_rows FROM dbo.user_account_priorities
GO
