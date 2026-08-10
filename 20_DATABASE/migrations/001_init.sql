-- =============================================================
-- KakeiFlow 初期スキーマ
-- 対象: Azure SQL Database (KakeiFlow_SQL / Japanese_CI_AS)
-- 方針:
--   * 金額はすべて BIGINT の円単位整数（DECIMAL + parseFloat 地獄を回避）
--   * 台帳は4分離（取引 / 予算配分 / プール / 未確定ストック）
--   * 予算とプールは追記専用。UPDATE せず SUM で導出する
--   * 削除は論理削除。FK は NO ACTION（多重カスケード経路を作らない）
-- 冪等: 既に存在するオブジェクトは作成しない
-- =============================================================

-- 適用済みマイグレーション管理
IF OBJECT_ID('dbo.schema_migrations', 'U') IS NULL
CREATE TABLE dbo.schema_migrations (
    version     NVARCHAR(50)  NOT NULL PRIMARY KEY,
    applied_at  DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME()
)
GO

-- ---------------------------------------------------------------
-- 世帯
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.households', 'U') IS NULL
CREATE TABLE dbo.households (
    id          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_households PRIMARY KEY,
    name        NVARCHAR(100) NOT NULL,
    created_at  DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME()
)
GO

-- ---------------------------------------------------------------
-- 利用者（Entra プリンシパルと紐付け）
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.users', 'U') IS NULL
CREATE TABLE dbo.users (
    id                BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_users PRIMARY KEY,
    household_id      BIGINT        NOT NULL CONSTRAINT fk_users_household REFERENCES dbo.households(id),
    email             NVARCHAR(256) NOT NULL,
    provider_user_id  NVARCHAR(200) NOT NULL,   -- Entra の oid クレーム
    display_name      NVARCHAR(100) NOT NULL,
    color             NVARCHAR(20)      NULL,
    role              NVARCHAR(20)  NOT NULL DEFAULT N'member'
        CONSTRAINT ck_users_role CHECK (role IN (N'owner', N'member')),
    is_active         BIT           NOT NULL DEFAULT 1,
    created_at        DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_users_provider  UNIQUE (provider_user_id),
    CONSTRAINT uq_users_email     UNIQUE (household_id, email)
)
GO

-- ---------------------------------------------------------------
-- プール（架空のお金の貯金箱。月をまたいで累積する）
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.pools', 'U') IS NULL
CREATE TABLE dbo.pools (
    id             BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_pools PRIMARY KEY,
    household_id   BIGINT        NOT NULL CONSTRAINT fk_pools_household REFERENCES dbo.households(id),
    name           NVARCHAR(60)  NOT NULL,
    purpose        NVARCHAR(200)     NULL,
    target_amount  BIGINT            NULL,   -- 目標額（進捗リング用）
    icon           NVARCHAR(40)      NULL,
    color          NVARCHAR(20)      NULL,
    order_index    INT           NOT NULL DEFAULT 0,
    is_archived    BIT           NOT NULL DEFAULT 0,
    created_at     DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_pools_name UNIQUE (household_id, name)
)
GO

-- ---------------------------------------------------------------
-- 予算カテゴリ（架空のお金の分類）
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.budget_categories', 'U') IS NULL
CREATE TABLE dbo.budget_categories (
    id                  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_budget_categories PRIMARY KEY,
    household_id        BIGINT        NOT NULL CONSTRAINT fk_bcat_household REFERENCES dbo.households(id),
    name                NVARCHAR(60)  NOT NULL,
    kind                NVARCHAR(10)  NOT NULL
        CONSTRAINT ck_bcat_kind CHECK (kind IN (N'expense', N'income')),
    carry_over_policy   NVARCHAR(20)  NOT NULL DEFAULT N'none'
        CONSTRAINT ck_bcat_carry CHECK (carry_over_policy IN (N'none', N'surplus', N'full', N'to_pool')),
    carry_over_pool_id  BIGINT            NULL CONSTRAINT fk_bcat_pool REFERENCES dbo.pools(id),
    parent_id           BIGINT            NULL CONSTRAINT fk_bcat_parent REFERENCES dbo.budget_categories(id),
    icon                NVARCHAR(40)      NULL,
    color               NVARCHAR(20)      NULL,
    order_index         INT           NOT NULL DEFAULT 0,
    is_archived         BIT           NOT NULL DEFAULT 0,
    created_at          DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_bcat_name UNIQUE (household_id, name),
    -- to_pool を選んだなら集約先プールは必須
    CONSTRAINT ck_bcat_pool_required CHECK (carry_over_policy <> N'to_pool' OR carry_over_pool_id IS NOT NULL)
)
GO

-- ---------------------------------------------------------------
-- 口座（実際のお金。財布・現金・電子マネー・証券・クレジットを統合）
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.accounts', 'U') IS NULL
CREATE TABLE dbo.accounts (
    id                  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_accounts PRIMARY KEY,
    household_id        BIGINT        NOT NULL CONSTRAINT fk_accounts_household REFERENCES dbo.households(id),
    name                NVARCHAR(60)  NOT NULL,
    kind                NVARCHAR(20)  NOT NULL
        CONSTRAINT ck_accounts_kind CHECK (kind IN (N'bank', N'cash', N'emoney', N'investment', N'credit')),
    owner_user_id       BIGINT            NULL CONSTRAINT fk_accounts_owner REFERENCES dbo.users(id),
    opening_balance     BIGINT        NOT NULL DEFAULT 0,
    opening_date        DATE          NOT NULL,
    -- kind = 'credit' のときのみ使用
    closing_day         TINYINT           NULL,
    payment_day         TINYINT           NULL,
    payment_account_id  BIGINT            NULL CONSTRAINT fk_accounts_payment REFERENCES dbo.accounts(id),
    icon                NVARCHAR(40)      NULL,
    color               NVARCHAR(20)      NULL,
    order_index         INT           NOT NULL DEFAULT 0,
    is_archived         BIT           NOT NULL DEFAULT 0,
    created_at          DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_accounts_name UNIQUE (household_id, name),
    -- クレジット専用項目は credit 以外では NULL でなければならない
    CONSTRAINT ck_accounts_credit_fields CHECK (
        kind = N'credit'
        OR (closing_day IS NULL AND payment_day IS NULL AND payment_account_id IS NULL)
    )
)
GO

-- ---------------------------------------------------------------
-- 予算期間（暦月固定。締めるとその月の配分操作を拒否する）
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.budget_periods', 'U') IS NULL
CREATE TABLE dbo.budget_periods (
    id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_budget_periods PRIMARY KEY,
    household_id  BIGINT       NOT NULL CONSTRAINT fk_period_household REFERENCES dbo.households(id),
    year_month    CHAR(7)      NOT NULL,   -- '2026-08'
    status        NVARCHAR(10) NOT NULL DEFAULT N'active'
        CONSTRAINT ck_period_status CHECK (status IN (N'active', N'closed')),
    closed_at     DATETIME2(3)     NULL,
    closed_by     BIGINT           NULL CONSTRAINT fk_period_closed_by REFERENCES dbo.users(id),
    created_at    DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_period UNIQUE (household_id, year_month)
)
GO

-- ---------------------------------------------------------------
-- 予算配分台帳（★追記専用。UPDATE / DELETE しない）
--   予算額 = SUM(amount)。この設計が組み換えバグを構造的に消す
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.budget_allocations', 'U') IS NULL
CREATE TABLE dbo.budget_allocations (
    id                 BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_budget_allocations PRIMARY KEY,
    household_id       BIGINT           NOT NULL CONSTRAINT fk_alloc_household REFERENCES dbo.households(id),
    year_month         CHAR(7)          NOT NULL,
    category_id        BIGINT           NOT NULL CONSTRAINT fk_alloc_category REFERENCES dbo.budget_categories(id),
    amount             BIGINT           NOT NULL,   -- 符号付き
    reason             NVARCHAR(20)     NOT NULL
        CONSTRAINT ck_alloc_reason CHECK (reason IN
            (N'initial', N'transfer', N'to_pool', N'from_pool', N'carry_over', N'adjust', N'reversal')),
    transfer_group_id  UNIQUEIDENTIFIER     NULL,   -- ゼロサム検証の単位
    reverses_id        BIGINT               NULL CONSTRAINT fk_alloc_reverses REFERENCES dbo.budget_allocations(id),
    note               NVARCHAR(200)        NULL,
    created_by         BIGINT               NULL CONSTRAINT fk_alloc_created_by REFERENCES dbo.users(id),
    created_at         DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME()
)
GO

-- 繰越の二重実行を物理的に防ぐ
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_alloc_carryover')
CREATE UNIQUE INDEX ux_alloc_carryover
    ON dbo.budget_allocations (household_id, year_month, category_id)
    WHERE reason = N'carry_over'
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_alloc_lookup')
CREATE INDEX ix_alloc_lookup
    ON dbo.budget_allocations (household_id, year_month, category_id)
    INCLUDE (amount, reason)
GO

-- ---------------------------------------------------------------
-- プール台帳（★追記専用・累積）
--   「予算から割り当てる」と「何もないところから追加する」の
--   2系統を扱うため budget_allocations とは別台帳にする
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.pool_movements', 'U') IS NULL
CREATE TABLE dbo.pool_movements (
    id                    BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_pool_movements PRIMARY KEY,
    household_id          BIGINT           NOT NULL CONSTRAINT fk_pmov_household REFERENCES dbo.households(id),
    pool_id               BIGINT           NOT NULL CONSTRAINT fk_pmov_pool REFERENCES dbo.pools(id),
    moved_on              DATE             NOT NULL,
    year_month            CHAR(7)          NOT NULL,
    amount                BIGINT           NOT NULL,   -- 符号付き
    reason                NVARCHAR(20)     NOT NULL
        CONSTRAINT ck_pmov_reason CHECK (reason IN
            (N'from_budget', N'to_budget', N'external_in', N'external_out',
             N'direct_spend', N'adjust', N'reversal')),
    transfer_group_id     UNIQUEIDENTIFIER     NULL,   -- 予算台帳とのクロスペア
    budget_allocation_id  BIGINT               NULL CONSTRAINT fk_pmov_alloc REFERENCES dbo.budget_allocations(id),
    entry_id              BIGINT               NULL,   -- entries 作成後に FK を追加
    reverses_id           BIGINT               NULL CONSTRAINT fk_pmov_reverses REFERENCES dbo.pool_movements(id),
    note                  NVARCHAR(200)        NULL,
    created_by            BIGINT               NULL CONSTRAINT fk_pmov_created_by REFERENCES dbo.users(id),
    created_at            DATETIME2(3)     NOT NULL DEFAULT SYSUTCDATETIME()
)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_pmov_pool')
CREATE INDEX ix_pmov_pool ON dbo.pool_movements (household_id, pool_id) INCLUDE (amount, reason, moved_on)
GO

-- ---------------------------------------------------------------
-- 取引台帳（実際のお金の動き）
--   ck_entries_shape が「種別変更でカテゴリが壊れる」問題への構造的な答え
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.entries', 'U') IS NULL
CREATE TABLE dbo.entries (
    id                  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_entries PRIMARY KEY,
    household_id        BIGINT            NOT NULL CONSTRAINT fk_entries_household REFERENCES dbo.households(id),
    client_id           UNIQUEIDENTIFIER      NULL,   -- オフライン登録の冪等キー
    entry_date          DATE              NOT NULL,
    kind                NVARCHAR(10)      NOT NULL
        CONSTRAINT ck_entries_kind CHECK (kind IN (N'expense', N'income', N'transfer', N'refund')),
    amount              BIGINT            NOT NULL CONSTRAINT ck_entries_amount CHECK (amount > 0),
    budget_category_id  BIGINT                NULL CONSTRAINT fk_entries_category REFERENCES dbo.budget_categories(id),
    account_id          BIGINT                NULL CONSTRAINT fk_entries_account REFERENCES dbo.accounts(id),
    counter_account_id  BIGINT                NULL CONSTRAINT fk_entries_counter REFERENCES dbo.accounts(id),
    pool_id             BIGINT                NULL CONSTRAINT fk_entries_pool REFERENCES dbo.pools(id),
    merchant            NVARCHAR(120)         NULL,
    memo                NVARCHAR(500)         NULL,
    -- 位置情報（取得できなくても登録は成立する。すべて NULL 許容）
    lat                 DECIMAL(9,6)          NULL,
    lng                 DECIMAL(9,6)          NULL,
    location_accuracy   INT                   NULL,
    place_key           NVARCHAR(100)         NULL,
    place_name          NVARCHAR(120)         NULL,
    place_category      NVARCHAR(60)          NULL,
    source              NVARCHAR(20)      NOT NULL DEFAULT N'manual'
        CONSTRAINT ck_entries_source CHECK (source IN (N'manual', N'stock', N'ai', N'recurring')),
    created_by          BIGINT                NULL CONSTRAINT fk_entries_created_by REFERENCES dbo.users(id),
    created_at          DATETIME2(3)      NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2(3)      NOT NULL DEFAULT SYSUTCDATETIME(),
    is_deleted          BIT               NOT NULL DEFAULT 0,
    -- 種別ごとに使ってよい列を DB が強制する
    CONSTRAINT ck_entries_shape CHECK (
        (kind IN (N'expense', N'income', N'refund')
            AND budget_category_id IS NOT NULL
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
)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_entries_client_id')
CREATE UNIQUE INDEX ux_entries_client_id
    ON dbo.entries (household_id, client_id)
    WHERE client_id IS NOT NULL
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_entries_date')
CREATE INDEX ix_entries_date
    ON dbo.entries (household_id, entry_date)
    INCLUDE (kind, amount, budget_category_id, account_id, counter_account_id)
    WHERE is_deleted = 0
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_entries_category')
CREATE INDEX ix_entries_category
    ON dbo.entries (household_id, budget_category_id, entry_date)
    INCLUDE (kind, amount)
    WHERE is_deleted = 0
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_entries_account')
CREATE INDEX ix_entries_account
    ON dbo.entries (household_id, account_id, entry_date)
    INCLUDE (kind, amount)
    WHERE is_deleted = 0
GO

-- pool_movements.entry_id の FK は entries 作成後に付与する
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_pmov_entry')
ALTER TABLE dbo.pool_movements
    ADD CONSTRAINT fk_pmov_entry FOREIGN KEY (entry_id) REFERENCES dbo.entries(id)
GO

-- ---------------------------------------------------------------
-- 明細分割（1レシートを複数カテゴリへ按分）
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.entry_splits', 'U') IS NULL
CREATE TABLE dbo.entry_splits (
    id                  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_entry_splits PRIMARY KEY,
    entry_id            BIGINT        NOT NULL CONSTRAINT fk_split_entry REFERENCES dbo.entries(id),
    budget_category_id  BIGINT        NOT NULL CONSTRAINT fk_split_category REFERENCES dbo.budget_categories(id),
    amount              BIGINT        NOT NULL CONSTRAINT ck_split_amount CHECK (amount > 0),
    memo                NVARCHAR(200)     NULL
)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_split_entry')
CREATE INDEX ix_split_entry ON dbo.entry_splits (entry_id)
GO

-- ---------------------------------------------------------------
-- レコードストック（確定するまで残高・予算に一切影響しない）
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.entry_stock', 'U') IS NULL
CREATE TABLE dbo.entry_stock (
    id                     BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_entry_stock PRIMARY KEY,
    household_id           BIGINT            NOT NULL CONSTRAINT fk_stock_household REFERENCES dbo.households(id),
    client_id              UNIQUEIDENTIFIER      NULL,
    raw_text               NVARCHAR(500)         NULL,
    amount                 BIGINT                NULL,
    entry_date             DATE                  NULL,
    captured_at            DATETIME2(3)      NOT NULL DEFAULT SYSUTCDATETIME(),
    suggested_kind         NVARCHAR(10)          NULL,
    suggested_category_id  BIGINT                NULL CONSTRAINT fk_stock_category REFERENCES dbo.budget_categories(id),
    suggested_account_id   BIGINT                NULL CONSTRAINT fk_stock_account REFERENCES dbo.accounts(id),
    suggested_pool_id      BIGINT                NULL CONSTRAINT fk_stock_pool REFERENCES dbo.pools(id),
    suggestion_reason      NVARCHAR(200)         NULL,
    confidence             DECIMAL(3,2)          NULL,
    lat                    DECIMAL(9,6)          NULL,
    lng                    DECIMAL(9,6)          NULL,
    location_accuracy      INT                   NULL,
    place_key              NVARCHAR(100)         NULL,
    place_name             NVARCHAR(120)         NULL,
    place_category         NVARCHAR(60)          NULL,
    source                 NVARCHAR(20)      NOT NULL DEFAULT N'quick'
        CONSTRAINT ck_stock_source CHECK (source IN (N'quick', N'ai', N'voice')),
    status                 NVARCHAR(12)      NOT NULL DEFAULT N'pending'
        CONSTRAINT ck_stock_status CHECK (status IN (N'pending', N'committed', N'discarded')),
    committed_entry_id     BIGINT                NULL CONSTRAINT fk_stock_entry REFERENCES dbo.entries(id),
    created_by             BIGINT                NULL CONSTRAINT fk_stock_created_by REFERENCES dbo.users(id),
    created_at             DATETIME2(3)      NOT NULL DEFAULT SYSUTCDATETIME()
)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_stock_client_id')
CREATE UNIQUE INDEX ux_stock_client_id
    ON dbo.entry_stock (household_id, client_id)
    WHERE client_id IS NOT NULL
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_stock_pending')
CREATE INDEX ix_stock_pending
    ON dbo.entry_stock (household_id, captured_at)
    WHERE status = N'pending'
GO

-- ---------------------------------------------------------------
-- 場所ヒント（同じ場所で前回選んだカテゴリを学習する）
--   AI 推論より速く確実で、呼び出しコストもゼロ
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.place_hints', 'U') IS NULL
CREATE TABLE dbo.place_hints (
    id                  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_place_hints PRIMARY KEY,
    household_id        BIGINT        NOT NULL CONSTRAINT fk_hint_household REFERENCES dbo.households(id),
    place_key           NVARCHAR(100) NOT NULL,
    place_name          NVARCHAR(120)     NULL,
    budget_category_id  BIGINT            NULL CONSTRAINT fk_hint_category REFERENCES dbo.budget_categories(id),
    account_id          BIGINT            NULL CONSTRAINT fk_hint_account REFERENCES dbo.accounts(id),
    use_count           INT           NOT NULL DEFAULT 1,
    last_used_at        DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME()
)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_place_hints')
CREATE UNIQUE INDEX ux_place_hints
    ON dbo.place_hints (household_id, place_key, budget_category_id, account_id)
GO

-- ---------------------------------------------------------------
-- 口座残高ビュー（残高カラムを持たず取引から導出する）
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.vw_account_balances', 'V') IS NOT NULL
    DROP VIEW dbo.vw_account_balances
GO
CREATE VIEW dbo.vw_account_balances
AS
SELECT
    a.id            AS account_id,
    a.household_id,
    a.name,
    a.kind,
    a.opening_balance
      + ISNULL(mv.delta, 0) AS balance
FROM dbo.accounts a
OUTER APPLY (
    SELECT SUM(x.delta) AS delta
    FROM (
        SELECT CASE e.kind
                    WHEN N'income'   THEN  e.amount
                    WHEN N'refund'   THEN  e.amount
                    WHEN N'expense'  THEN -e.amount
                    WHEN N'transfer' THEN -e.amount
               END AS delta
        FROM dbo.entries e
        WHERE e.account_id = a.id AND e.is_deleted = 0
        UNION ALL
        SELECT e.amount AS delta
        FROM dbo.entries e
        WHERE e.counter_account_id = a.id AND e.kind = N'transfer' AND e.is_deleted = 0
    ) x
) mv
GO

-- ---------------------------------------------------------------
-- プール残高ビュー
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.vw_pool_balances', 'V') IS NOT NULL
    DROP VIEW dbo.vw_pool_balances
GO
CREATE VIEW dbo.vw_pool_balances
AS
SELECT
    p.id           AS pool_id,
    p.household_id,
    p.name,
    p.target_amount,
    ISNULL((SELECT SUM(m.amount) FROM dbo.pool_movements m WHERE m.pool_id = p.id), 0) AS balance
FROM dbo.pools p
GO

-- ---------------------------------------------------------------
-- 適用記録
-- ---------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'001_init')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'001_init')
GO
