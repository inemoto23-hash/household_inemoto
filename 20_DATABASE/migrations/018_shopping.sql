-- ===============================================================
-- 018: 買い物メモ
--
-- 日付にぶら下がる ToDo リスト。品名とチェックだけを持つ。
--
-- **schedules を拡張しない。** 予定は時刻・通知の宛先を持ち、
-- schedule_reminders から FK で指されている。買い物メモにはどれも要らず、
-- 拡張すると「通知の無い予定」という第2の形が reminderSweep と
-- 一覧の並び替えに混ざり込む。日付にぶら下がる点が同じなだけで性質が違う。
--
-- **台帳ではない。** entries とは一切接続せず、残高にも予算にも影響しない。
-- 買い物の後に記帳するときは、これまで通り金額だけを手で入れる。
-- ===============================================================

IF OBJECT_ID('dbo.shopping_items', 'U') IS NULL
CREATE TABLE dbo.shopping_items (
    id             BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_shopping_items PRIMARY KEY,
    household_id   BIGINT        NOT NULL CONSTRAINT fk_shop_household REFERENCES dbo.households(id),

    -- どの日の買い物か。カレンダーの選択日そのもの
    planned_on     DATE          NOT NULL,

    -- 品名だけ。想定金額・カテゴリ・担当者は持たない。
    -- 持たせると「明細分割」を先取りすることになり、リストが台帳へ滲む
    name           NVARCHAR(120) NOT NULL
        CONSTRAINT ck_shop_name CHECK (LEN(LTRIM(RTRIM(name))) > 0),

    is_checked     BIT           NOT NULL CONSTRAINT df_shop_checked DEFAULT 0,

    created_by     BIGINT            NULL CONSTRAINT fk_shop_created_by REFERENCES dbo.users(id),
    created_at     DATETIME2(3)  NOT NULL CONSTRAINT df_shop_created DEFAULT SYSUTCDATETIME(),
    updated_at     DATETIME2(3)  NOT NULL CONSTRAINT df_shop_updated DEFAULT SYSUTCDATETIME()

    -- 論理削除は持たない。schedules が is_deleted を持つのは通知予約が
    -- FK で指しているため。こちらは何からも指されない使い捨てのメモなので、
    -- 消したいときは物理 DELETE でよい
)
GO

-- 画面はいつも「その日1日」を引く。並びは id 昇順（追加順）で固定するので、
-- 索引に順序を持たせる必要はない
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_shop_date')
CREATE INDEX ix_shop_date
    ON dbo.shopping_items (household_id, planned_on)
    INCLUDE (name, is_checked)
GO

IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE version = N'018_shopping')
    INSERT INTO dbo.schema_migrations (version) VALUES (N'018_shopping')
GO

-- 確認。新しい入れ物なので件数は 0 が正しい。
-- テーブルと索引ができたことだけを見る
SELECT (SELECT COUNT(*) FROM sys.indexes
         WHERE name = 'ix_shop_date')                                      AS 索引,
       (SELECT COUNT(*) FROM dbo.shopping_items)                           AS 件数
GO
