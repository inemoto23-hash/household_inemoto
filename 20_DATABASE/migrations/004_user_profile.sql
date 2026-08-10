-- =============================================================
-- 004: 利用者のプロフィール（表示名・アイコン・アバター画像）
--
-- アバター画像は DB に直接持つ。理由:
--   * ストレージは allowSharedKeyAccess=false（キー禁止）にしてあり、
--     ブラウザへ直接見せるには利用者委任SASの発行が必要で、
--     数KBの画像のためには構成が重すぎる
--   * 画像はクライアント側で 256px 以下へ縮小してから送るため 1件あたり数十KB。
--     世帯メンバー数を考えれば DB 容量(2GB)への影響は無視できる
-- レシート等の大きなファイルを扱う段になったら Blob + 利用者委任SAS を導入する。
-- 冪等: 何度実行してもよい
-- =============================================================

-- ---- 絵文字アイコン -----------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.users') AND name = 'icon')
    ALTER TABLE dbo.users ADD icon NVARCHAR(16) NULL
GO

-- ---- アバター画像 -------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.users') AND name = 'avatar_data')
    ALTER TABLE dbo.users ADD avatar_data VARBINARY(MAX) NULL
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.users') AND name = 'avatar_mime')
    ALTER TABLE dbo.users ADD avatar_mime NVARCHAR(50) NULL
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.users') AND name = 'avatar_updated_at')
    ALTER TABLE dbo.users ADD avatar_updated_at DATETIME2(3) NULL
GO

-- ---- 適用記録 -----------------------------------------------
IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'004_user_profile')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'004_user_profile')
GO

-- ---- 確認 ---------------------------------------------------
SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME = 'users'
   AND COLUMN_NAME IN ('icon', 'color', 'avatar_data', 'avatar_mime', 'avatar_updated_at')
 ORDER BY COLUMN_NAME
GO
