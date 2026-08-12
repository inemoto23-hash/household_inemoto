-- ===============================================================
-- 017: 場所マスタ
--
-- 「イオン」を2店舗で使うと、店名でまとめている限り1つの場所として
-- 数えられる。支出マップのピンはどちらか一方（または中間）に立ち、
-- 分析の金額も合算される。同じ店として扱ってよいかは店名では決まらない。
--
-- **束ねる鍵は座標のかたまり。地名は表示のための飾り。**
-- 町境の近くにある店は、GPS のばらつきで訪問ごとに町名が変わりうる。
-- 「店名＋地名」を鍵にすると同じ店が2つに割れるため、鍵にしない。
--
-- 地名は国土地理院の逆ジオコーディングから取る。API キーが要らないので、
-- 「接続文字列とAPIキーをどこにも保持しない」という方針を崩さずに済む。
-- ただし SLA が無いので、**取れたものを保存して二度と呼ばない**。
-- 止まっても既存のマスタは動き続け、新規登録に地名が付かないだけで済む。
-- ===============================================================

IF OBJECT_ID('dbo.places', 'U') IS NULL
CREATE TABLE dbo.places (
    id              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_places PRIMARY KEY,
    household_id    BIGINT        NOT NULL CONSTRAINT fk_places_household REFERENCES dbo.households(id),

    -- 利用者の呼び方。外から取った正式名称ではない
    name            NVARCHAR(120) NOT NULL,

    -- ---- 座標。これがマスタの本体 ----
    -- 座標を持たないマスタもある（自宅・一括登録・PC からの記録しかない店）。
    -- その場合は名前だけで突き合わせる
    lat             DECIMAL(9,6)      NULL,
    lng             DECIMAL(9,6)      NULL,

    -- ---- 地名。表示のためだけに持つ ----
    muni_cd         NVARCHAR(10)      NULL,   -- 11216
    area_name       NVARCHAR(80)      NULL,   -- 羽生市
    area_detail     NVARCHAR(80)      NULL,   -- 東六丁目

    -- 地名を引いた時刻。NULL なら未処理＝定時ジョブが拾う
    geocoded_at     DATETIME2(0)      NULL,
    -- 連続失敗回数。無限に叩き続けないための歯止め
    geocode_fails   INT           NOT NULL CONSTRAINT df_places_fails DEFAULT 0,

    is_archived     BIT           NOT NULL CONSTRAINT df_places_archived DEFAULT 0,
    created_at      DATETIME2(0)  NOT NULL CONSTRAINT df_places_created DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2(0)  NOT NULL CONSTRAINT df_places_updated DEFAULT SYSUTCDATETIME(),

    -- 画面と集計で使う表示名。**ここを唯一の出どころにする。**
    -- 各所で組み立てると「一覧は羽生市付き、地図は無し」のようにずれる
    display_name AS (
        CASE WHEN area_name IS NULL THEN name
             ELSE name + N'（' + area_name + N'）' END
    ) PERSISTED
)
GO

-- 名前で候補を絞ってから距離で確定する。矩形で絞る home の探し方と同じ考え方
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_places_household_name')
CREATE INDEX ix_places_household_name ON dbo.places (household_id, name) INCLUDE (lat, lng)
GO

-- 定時ジョブが「まだ地名を引いていないもの」を拾うため。
-- 座標が無ければ引きようがないので対象外
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_places_pending_geocode')
CREATE INDEX ix_places_pending_geocode ON dbo.places (household_id, id)
    WHERE geocoded_at IS NULL AND lat IS NOT NULL
GO

-- ---------------------------------------------------------------
-- entries から場所を指す
-- ---------------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('dbo.entries') AND name = 'place_id'
)
ALTER TABLE dbo.entries ADD place_id BIGINT NULL
    CONSTRAINT fk_entries_place REFERENCES dbo.places(id)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_entries_place')
CREATE INDEX ix_entries_place ON dbo.entries (household_id, place_id)
    WHERE place_id IS NOT NULL
GO

-- ===============================================================
-- 初回の埋め戻し
--
-- 既存の記録からマスタを作る。**外部 API は呼ばない。**
-- 地名は後から定時ジョブが埋めるので、ここでは座標と名前だけ決める。
--
-- 同じ店名でも離れた場所は別の店として分けたいが、SQL だけで
-- クラスタリングはできない。ここでは「店名ごとに1件」を作り、
-- 座標は**いちばん新しい座標つきの記録**を代表にする。
-- 分割が要るものは、以後の記録で座標が離れたときにアプリ側が新しく作る。
-- ===============================================================

IF NOT EXISTS (SELECT 1 FROM dbo.places)
BEGIN
    ;WITH src AS (
        SELECT e.household_id,
               COALESCE(e.merchant, e.place_name) AS name,
               e.lat, e.lng,
               ROW_NUMBER() OVER (
                 PARTITION BY e.household_id, COALESCE(e.merchant, e.place_name)
                 ORDER BY CASE WHEN e.lat IS NULL THEN 1 ELSE 0 END,
                          e.entry_date DESC, e.id DESC
               ) AS rn
          FROM dbo.entries e
         WHERE e.is_deleted = 0
           AND COALESCE(e.merchant, e.place_name) IS NOT NULL
    )
    INSERT INTO dbo.places (household_id, name, lat, lng)
    SELECT household_id, name, lat, lng FROM src WHERE rn = 1;
END
GO

-- 既存の記録をマスタへ紐付ける
UPDATE e
   SET place_id = p.id
  FROM dbo.entries e
  JOIN dbo.places p
    ON p.household_id = e.household_id
   AND p.name = COALESCE(e.merchant, e.place_name)
 WHERE e.place_id IS NULL
   AND e.is_deleted = 0
   AND COALESCE(e.merchant, e.place_name) IS NOT NULL
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'017_places')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'017_places')
GO

-- 確認。件数と、地名待ちの件数を出す
SELECT (SELECT COUNT(*) FROM dbo.places)                                   AS マスタ件数,
       (SELECT COUNT(*) FROM dbo.places WHERE lat IS NOT NULL)             AS 座標あり,
       (SELECT COUNT(*) FROM dbo.places WHERE geocoded_at IS NULL
                                          AND lat IS NOT NULL)             AS 地名待ち,
       (SELECT COUNT(*) FROM dbo.entries WHERE place_id IS NOT NULL)       AS 紐付いた記録,
       (SELECT COUNT(*) FROM dbo.entries
         WHERE place_id IS NULL AND is_deleted = 0
           AND COALESCE(merchant, place_name) IS NOT NULL)                 AS 未紐付け
GO
