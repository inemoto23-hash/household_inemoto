-- ===============================================================
-- 012: 自宅の登録
--
-- クレジットカードの履歴は、店ではなく自宅でまとめて付けることが多い。
-- そのとき位置情報を添えると、支出マップに自宅が並び、
-- 店名の候補も自宅の近所から出てしまう。
--
-- 自宅の範囲で記録したものは、そもそも座標を保存しない。
-- 保存した上で地図側で除外する形にすると、除外条件が
-- 地図・分析・店名候補の3か所に散らばり、いずれ抜ける。
--
-- 1世帯に1つだけの値なのでテーブルは増やさず households に持たせる。
-- ===============================================================

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('dbo.households') AND name = 'home_lat'
)
ALTER TABLE dbo.households ADD
    home_lat      DECIMAL(9,6) NULL,
    home_lng      DECIMAL(9,6) NULL,
    -- 既定は50m。屋内では GPS が数十m ずれるため画面から広げられるようにする
    home_radius_m INT NOT NULL CONSTRAINT df_home_radius DEFAULT 50
        CONSTRAINT ck_home_radius CHECK (home_radius_m BETWEEN 20 AND 2000)
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'012_home')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'012_home')
GO

SELECT name, system_type_id, is_nullable
  FROM sys.columns
 WHERE object_id = OBJECT_ID('dbo.households') AND name LIKE 'home%'
GO
