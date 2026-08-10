-- =============================================================
-- KakeiFlow 初期マスタデータ
-- 旧アプリのカテゴリ構成を引き継ぎつつ、新モデル（口座統合・プール）へ写像する。
-- 取引データは移行しない（完全新規スタート）。
-- 冪等: 何度実行しても重複しない
-- =============================================================

DECLARE @household_id BIGINT;
DECLARE @owner_oid    NVARCHAR(200) = N'cdc551ed-e727-431b-80e0-438ca47f0095';

-- ---- 世帯 -------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.households)
    INSERT INTO dbo.households (name) VALUES (N'わが家');

SELECT TOP 1 @household_id = id FROM dbo.households ORDER BY id;

-- ---- 利用者（オーナー） -----------------------------------
-- display_name は暫定値。設定画面から変更できる
IF NOT EXISTS (SELECT 1 FROM dbo.users WHERE provider_user_id = @owner_oid)
    INSERT INTO dbo.users (household_id, email, provider_user_id, display_name, role)
    VALUES (@household_id, N'inemoto23@gmail.com', @owner_oid, N'inemoto23', N'owner');

-- ---- プール（予備費） -------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.pools WHERE household_id = @household_id AND name = N'予備費')
    INSERT INTO dbo.pools (household_id, name, purpose, order_index, icon, color)
    VALUES (@household_id, N'予備費', N'急な出費に備える。予算からの拠出と臨時の積み増しの両方を受け付ける', 0, N'shield', N'#6366f1');

-- ---- 予算カテゴリ（支出） ---------------------------------
MERGE dbo.budget_categories AS t
USING (VALUES
    (N'食費',     N'expense', 0,  N'none'),
    (N'生活費',   N'expense', 1,  N'none'),
    (N'養育費',   N'expense', 2,  N'none'),
    (N'ローン',   N'expense', 3,  N'none'),
    (N'小遣い',   N'expense', 4,  N'full'),      -- 使いすぎた分は翌月減る
    (N'娯楽費',   N'expense', 5,  N'surplus'),   -- 余りは翌月へ
    (N'車維持費', N'expense', 6,  N'surplus'),
    (N'医療費',   N'expense', 7,  N'none'),
    (N'公共料金', N'expense', 8,  N'none'),
    (N'投資',     N'expense', 9,  N'none'),
    (N'給与',     N'income',  20, N'none'),
    (N'その他収入', N'income', 21, N'none')
) AS s (name, kind, order_index, carry_over_policy)
    ON t.household_id = @household_id AND t.name = s.name
WHEN NOT MATCHED THEN
    INSERT (household_id, name, kind, order_index, carry_over_policy)
    VALUES (@household_id, s.name, s.kind, s.order_index, s.carry_over_policy);

-- ---- 口座（財布・クレジット統合） -------------------------
MERGE dbo.accounts AS t
USING (VALUES
    (N'三井住友銀行',   N'bank',       0),
    (N'埼玉りそな銀行', N'bank',       1),
    (N'楽天銀行',       N'bank',       2),
    (N'楽天証券',       N'investment', 3),
    (N'住信SBI証券',    N'investment', 4),
    (N'現金たけ',       N'cash',       5),
    (N'現金ささ',       N'cash',       6),
    (N'Suicaたけ',      N'emoney',     7),
    (N'Suicaささ',      N'emoney',     8),
    (N'楽天Payたけ',    N'emoney',     9),
    (N'楽天Payささ',    N'emoney',    10),
    (N'楽天カード',     N'credit',    20),
    (N'PayPay',         N'credit',    21)
) AS s (name, kind, order_index)
    ON t.household_id = @household_id AND t.name = s.name
WHEN NOT MATCHED THEN
    INSERT (household_id, name, kind, order_index, opening_balance, opening_date)
    VALUES (@household_id, s.name, s.kind, s.order_index, 0, '2026-08-01');

-- ---- 当月の予算期間 ---------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.budget_periods WHERE household_id = @household_id AND year_month = '2026-08')
    INSERT INTO dbo.budget_periods (household_id, year_month) VALUES (@household_id, '2026-08');
GO

-- ---- 確認 -------------------------------------------------
SELECT
    (SELECT COUNT(*) FROM dbo.households)        AS households,
    (SELECT COUNT(*) FROM dbo.users)             AS users,
    (SELECT COUNT(*) FROM dbo.pools)             AS pools,
    (SELECT COUNT(*) FROM dbo.budget_categories) AS categories,
    (SELECT COUNT(*) FROM dbo.accounts)          AS accounts,
    (SELECT COUNT(*) FROM dbo.budget_periods)    AS periods
GO
