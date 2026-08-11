-- ===============================================================
-- 010: 通知の取り出し状態
--
-- 送信は「遅れてもよいが二重に送ってはいけない」。
-- 取り出しと同時に status を sending へ変えることで、
-- 同じ予約を2つの実行が同時に処理しないようにする。
--
-- 送信中にプロセスが落ちると sending のまま残るため、
-- 取り出した時刻を持たせて、一定時間を過ぎたものは拾い直せるようにする。
-- ===============================================================

ALTER TABLE dbo.schedule_reminders DROP CONSTRAINT ck_rem_status
GO

ALTER TABLE dbo.schedule_reminders WITH CHECK
    ADD CONSTRAINT ck_rem_status CHECK (status IN
        (N'pending', N'sending', N'sent', N'failed', N'cancelled'))
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('dbo.schedule_reminders') AND name = 'claimed_at'
)
ALTER TABLE dbo.schedule_reminders ADD claimed_at DATETIME2(3) NULL
GO
