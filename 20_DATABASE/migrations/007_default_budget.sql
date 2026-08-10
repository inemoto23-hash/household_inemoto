-- ===============================================================
-- 007: カテゴリごとの既定予算
--
-- 毎月ほぼ同じ額を配分するのに、月が変わるたび全カテゴリを入力し直すのは無駄。
-- 「いつもの額」をカテゴリに持たせ、新しい月はそこから始める。
--
-- 月ごとに変動する実際の配分は budget_allocations が引き続き正とする。
-- この列はあくまで新しい月の初期値であり、遡って過去の月を変えることはない。
-- ===============================================================

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('dbo.budget_categories') AND name = 'default_amount'
)
ALTER TABLE dbo.budget_categories
    ADD default_amount BIGINT NOT NULL CONSTRAINT df_bcat_default_amount DEFAULT 0
GO
