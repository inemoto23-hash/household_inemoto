-- ===============================================================
-- 015: チャージ元の口座
--
-- チャージ元は実際には常に同じ口座なので、記録のたびに選ばせない。
-- 口座に印を付けておき、記録画面ではチャージ先だけを選ぶ。
--
-- 世帯にひとつだけという決まりは、フィルタ付き一意インデックスで DB に守らせる。
-- 付け替えは「先に他を落としてから立てる」でアプリが行うが、
-- 落とし忘れれば索引が必ず弾くので、黙って2つ立つことは起きない。
--
-- 種別は縛らない。クレジットからも銀行からもチャージするため。
-- ===============================================================

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('dbo.accounts') AND name = 'is_charge_source'
)
ALTER TABLE dbo.accounts ADD is_charge_source BIT NOT NULL
    CONSTRAINT df_acc_charge_source DEFAULT 0
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_accounts_charge_source')
CREATE UNIQUE INDEX ux_accounts_charge_source
    ON dbo.accounts (household_id)
    WHERE is_charge_source = 1
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'015_charge_source')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'015_charge_source')
GO

SELECT id, name, kind, is_charge_source FROM dbo.accounts WHERE household_id = 1 ORDER BY order_index
GO
