-- ===============================================================
-- 009: 予定メモと通知
--
-- 家計の記録とは別の台帳にする。予定は残高にも予算にも影響しないため、
-- entries に混ぜると集計のたびに除外条件が要る。
-- ===============================================================

IF OBJECT_ID('dbo.schedules', 'U') IS NULL
CREATE TABLE dbo.schedules (
    id             BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_schedules PRIMARY KEY,
    household_id   BIGINT        NOT NULL CONSTRAINT fk_sched_household REFERENCES dbo.households(id),
    scheduled_on   DATE          NOT NULL,
    -- 0時からの分。終日なら NULL。
    -- TIME 型は node-mssql が 1970-01-01 の Date として返すため取り違えやすい。
    -- 金額を BIGINT 整数で持つのと同じ理由で、素直な整数にしておく
    start_minutes  SMALLINT          NULL
        CONSTRAINT ck_sched_start CHECK (start_minutes IS NULL OR (start_minutes BETWEEN 0 AND 1439)),
    title          NVARCHAR(120) NOT NULL,
    detail         NVARCHAR(2000)    NULL,
    -- 通知を誰に届けるか
    audience       NVARCHAR(10)  NOT NULL DEFAULT N'household'
        CONSTRAINT ck_sched_audience CHECK (audience IN (N'creator', N'household')),
    color          NVARCHAR(20)      NULL,
    is_done        BIT           NOT NULL DEFAULT 0,
    created_by     BIGINT            NULL CONSTRAINT fk_sched_created_by REFERENCES dbo.users(id),
    created_at     DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at     DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    is_deleted     BIT           NOT NULL DEFAULT 0
)
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_sched_date')
CREATE INDEX ix_sched_date
    ON dbo.schedules (household_id, scheduled_on)
    INCLUDE (start_minutes, title, is_done)
    WHERE is_deleted = 0
GO

-- ---------------------------------------------------------------
-- 通知予約
--   予定1件につき複数持てる（当日・1時間前 など）。
--   send_at は UTC。予定を直したら作り直す
-- ---------------------------------------------------------------
IF OBJECT_ID('dbo.schedule_reminders', 'U') IS NULL
CREATE TABLE dbo.schedule_reminders (
    id              BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT pk_sched_reminders PRIMARY KEY,
    schedule_id     BIGINT        NOT NULL CONSTRAINT fk_rem_schedule REFERENCES dbo.schedules(id),
    household_id    BIGINT        NOT NULL CONSTRAINT fk_rem_household REFERENCES dbo.households(id),
    -- 予定時刻の何分前に送るか。0 は予定時刻ちょうど
    offset_minutes  INT           NOT NULL,
    send_at         DATETIME2(3)  NOT NULL,
    status          NVARCHAR(12)  NOT NULL DEFAULT N'pending'
        CONSTRAINT ck_rem_status CHECK (status IN (N'pending', N'sent', N'failed', N'cancelled')),
    sent_at         DATETIME2(3)      NULL,
    attempts        INT           NOT NULL DEFAULT 0,
    last_error      NVARCHAR(400)     NULL,
    created_at      DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_rem_offset UNIQUE (schedule_id, offset_minutes)
)
GO

-- 送信対象だけを引くための索引
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_rem_due')
CREATE INDEX ix_rem_due
    ON dbo.schedule_reminders (send_at)
    INCLUDE (schedule_id, household_id, offset_minutes)
    WHERE status = N'pending'
GO
