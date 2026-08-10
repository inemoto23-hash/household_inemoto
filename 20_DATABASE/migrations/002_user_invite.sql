-- =============================================================
-- 002: 世帯メンバーの招待と既定財布
--
-- * users.provider_user_id を NULL 許容にして「招待済み・未サインイン」を表現する
--   （Entra の oid は本人が初回サインインするまで分からないため）
-- * users.default_account_id を追加し、入力時の既定財布を持たせる
-- * 小遣いカテゴリを人別に分割する（繰越が個人単位で成立するようにする）
-- 冪等: 何度実行してもよい
-- =============================================================

-- ---- provider_user_id を NULL 許容へ -------------------------
-- UNIQUE 制約は NULL を1行しか許さないため、フィルタ付き一意インデックスへ置き換える
IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'uq_users_provider')
    ALTER TABLE dbo.users DROP CONSTRAINT uq_users_provider
GO

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.users') AND name = 'provider_user_id' AND is_nullable = 0
)
    ALTER TABLE dbo.users ALTER COLUMN provider_user_id NVARCHAR(200) NULL
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_users_provider')
    CREATE UNIQUE INDEX ux_users_provider
        ON dbo.users (provider_user_id)
        WHERE provider_user_id IS NOT NULL
GO

-- ---- 既定財布 -----------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.users') AND name = 'default_account_id'
)
    ALTER TABLE dbo.users
        ADD default_account_id BIGINT NULL
            CONSTRAINT fk_users_default_account REFERENCES dbo.accounts(id)
GO

-- ---- 招待の記録 ---------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.users') AND name = 'invited_at'
)
    ALTER TABLE dbo.users ADD invited_at DATETIME2(3) NULL
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.users') AND name = 'invited_by'
)
    ALTER TABLE dbo.users
        ADD invited_by BIGINT NULL CONSTRAINT fk_users_invited_by REFERENCES dbo.users(id)
GO

-- ---- 小遣いカテゴリを人別に分割 -----------------------------
-- 取引が0件のうちに実施する。繰越ポリシーは 'full'（赤字も翌月へ）を維持
DECLARE @household_id BIGINT;
SELECT TOP 1 @household_id = id FROM dbo.households ORDER BY id;

IF @household_id IS NOT NULL
BEGIN
    -- 既存の「小遣い」を「小遣いたけ」へ改称
    IF EXISTS (SELECT 1 FROM dbo.budget_categories WHERE household_id = @household_id AND name = N'小遣い')
       AND NOT EXISTS (SELECT 1 FROM dbo.budget_categories WHERE household_id = @household_id AND name = N'小遣いたけ')
        UPDATE dbo.budget_categories
           SET name = N'小遣いたけ'
         WHERE household_id = @household_id AND name = N'小遣い';

    -- 「小遣いささ」を追加
    IF NOT EXISTS (SELECT 1 FROM dbo.budget_categories WHERE household_id = @household_id AND name = N'小遣いささ')
        INSERT INTO dbo.budget_categories (household_id, name, kind, order_index, carry_over_policy)
        VALUES (@household_id, N'小遣いささ', N'expense', 5, N'full');
END
GO

-- ---- 適用記録 -----------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'002_user_invite')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'002_user_invite')
GO

-- ---- 確認 ---------------------------------------------------
SELECT name, kind, order_index, carry_over_policy
  FROM dbo.budget_categories
 WHERE name LIKE N'小遣い%'
 ORDER BY name
GO

SELECT
    COLUMN_NAME   AS column_name,
    IS_NULLABLE   AS is_nullable,
    DATA_TYPE     AS data_type
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME = 'users'
   AND COLUMN_NAME IN ('provider_user_id', 'default_account_id', 'invited_at', 'invited_by')
 ORDER BY COLUMN_NAME
GO
