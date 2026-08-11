-- ===============================================================
-- 011: 定期取引
--
-- 家賃・サブスクのように毎月同じ記録を、規則として1行持つ。
--
-- 未来の取引行は作らない。先に entries へ入れてしまうと、まだ払っていない
-- お金で残高が減り、予算も消化済みに見えてしまう。
-- 日次タイマーが「その日が来たものだけ」を実体化する。
--
-- 台帳との違い：budget_allocations や pool_movements は追記専用だが、
-- ここは「次にいつ記帳するか」を持つ規則なので更新される。事実の記録ではない。
-- ===============================================================

IF OBJECT_ID('dbo.recurring_rules', 'U') IS NULL
CREATE TABLE dbo.recurring_rules (
    id                  BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_recurring PRIMARY KEY,
    household_id        BIGINT        NOT NULL CONSTRAINT fk_rec_household REFERENCES dbo.households(id),

    -- ---- 取引の雛形。entries と同じ形にしておく ----
    kind                NVARCHAR(10)  NOT NULL
        CONSTRAINT ck_rec_kind CHECK (kind IN (N'expense', N'income', N'transfer')),
    amount              BIGINT        NOT NULL CONSTRAINT ck_rec_amount CHECK (amount > 0),
    budget_category_id  BIGINT            NULL CONSTRAINT fk_rec_category REFERENCES dbo.budget_categories(id),
    pool_id             BIGINT            NULL CONSTRAINT fk_rec_pool REFERENCES dbo.pools(id),
    account_id          BIGINT        NOT NULL CONSTRAINT fk_rec_account REFERENCES dbo.accounts(id),
    counter_account_id  BIGINT            NULL CONSTRAINT fk_rec_counter REFERENCES dbo.accounts(id),
    merchant            NVARCHAR(120)     NULL,
    memo                NVARCHAR(500)     NULL,

    -- ---- 繰り返しの条件 ----
    freq                NVARCHAR(10)  NOT NULL
        CONSTRAINT ck_rec_freq CHECK (freq IN (N'monthly', N'weekly', N'yearly')),
    -- 何回ごとか。2 なら隔月・隔週
    interval_n          SMALLINT      NOT NULL DEFAULT 1
        CONSTRAINT ck_rec_interval CHECK (interval_n BETWEEN 1 AND 12),
    -- 31 は「月末」の意味も兼ねる。2月は28（閏なら29）日へ丸める
    day_of_month        TINYINT           NULL
        CONSTRAINT ck_rec_dom CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31),
    month_of_year       TINYINT           NULL
        CONSTRAINT ck_rec_moy CHECK (month_of_year IS NULL OR month_of_year BETWEEN 1 AND 12),
    -- 0=日 .. 6=土
    weekday             TINYINT           NULL
        CONSTRAINT ck_rec_weekday CHECK (weekday IS NULL OR weekday BETWEEN 0 AND 6),

    -- ---- 期間と進捗 ----
    start_date          DATE          NOT NULL,
    end_date            DATE              NULL,
    -- 次に記帳する日。終了したら NULL
    next_date           DATE              NULL,
    last_posted_date    DATE              NULL,

    is_active           BIT           NOT NULL DEFAULT 1,
    is_deleted          BIT           NOT NULL DEFAULT 0,
    created_by          BIGINT            NULL CONSTRAINT fk_rec_created_by REFERENCES dbo.users(id),
    created_at          DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at          DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),

    -- 種別ごとに使ってよい列を DB が強制する。entries の ck_entries_shape と同じ形。
    -- 画面やアプリの整合処理には依存しない
    CONSTRAINT ck_rec_shape CHECK (
        (kind = N'expense'
            AND counter_account_id IS NULL
            AND ((budget_category_id IS NOT NULL AND pool_id IS NULL)
              OR (budget_category_id IS NULL     AND pool_id IS NOT NULL)))
        OR
        (kind = N'income'
            AND budget_category_id IS NOT NULL
            AND pool_id            IS NULL
            AND counter_account_id IS NULL)
        OR
        (kind = N'transfer'
            AND budget_category_id IS NULL
            AND pool_id            IS NULL
            AND counter_account_id IS NOT NULL
            AND account_id <> counter_account_id)
    ),

    -- 頻度ごとに必要な項目が揃っていることを保証する
    CONSTRAINT ck_rec_freq_shape CHECK (
        (freq = N'monthly' AND day_of_month IS NOT NULL AND weekday IS NULL AND month_of_year IS NULL)
        OR
        (freq = N'weekly'  AND weekday IS NOT NULL AND day_of_month IS NULL AND month_of_year IS NULL)
        OR
        (freq = N'yearly'  AND day_of_month IS NOT NULL AND month_of_year IS NOT NULL AND weekday IS NULL)
    )
)
GO

-- タイマーが毎日引く唯一のクエリのための索引
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_rec_due')
CREATE INDEX ix_rec_due
    ON dbo.recurring_rules (next_date)
    INCLUDE (household_id, kind, amount)
    WHERE is_active = 1 AND is_deleted = 0 AND next_date IS NOT NULL
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_rec_household')
CREATE INDEX ix_rec_household
    ON dbo.recurring_rules (household_id, next_date)
    WHERE is_deleted = 0
GO

-- ---------------------------------------------------------------
-- 取引側に「どの規則から生まれたか」を持たせる。
--
-- フィルタ付き一意インデックスが二重記帳を DB で止める。
-- タイマーが重複起動しても、手動の「今すぐ記帳」と重なっても、2件目は入らない。
-- ---------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('dbo.entries') AND name = 'recurring_rule_id'
)
ALTER TABLE dbo.entries ADD recurring_rule_id BIGINT NULL
    CONSTRAINT fk_entries_recurring REFERENCES dbo.recurring_rules(id)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_entries_recurring')
CREATE UNIQUE INDEX ux_entries_recurring
    ON dbo.entries (recurring_rule_id, entry_date)
    WHERE recurring_rule_id IS NOT NULL
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'011_recurring')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'011_recurring')
GO

SELECT COUNT(*) AS rule_columns FROM sys.columns WHERE object_id = OBJECT_ID('dbo.recurring_rules')
GO
