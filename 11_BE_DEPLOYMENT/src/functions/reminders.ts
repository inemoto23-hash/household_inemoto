/**
 * 通知の送信。5分ごとに、送る時刻を過ぎた予約を拾ってメールを出す。
 *
 * 遅れて送るのは許すが、二重に送るのは許さない。
 * そのため取り出しと同時に status を変え、同じ予約を2回処理しないようにする。
 *
 * 送信に失敗したら残して次回に回す。3回で諦める。
 * 通知が来ないより、遅れてでも来るほうがよい。
 */
import { app, InvocationContext, Timer } from '@azure/functions';
import { getPool, sql } from '../db/pool';
import { num } from '../db/convert';
import { isEmailConfigured, sendMail } from '../shared/email';
import { formatMoment, formatOffset } from '../domain/schedule';

/** 1回で処理する上限。詰まっても次の5分で続きを拾う */
const BATCH_SIZE = 20;
/** これを超えたら諦める */
const MAX_ATTEMPTS = 3;
/** 送る時刻をこれ以上過ぎたものは送らない（復旧時に古い通知が大量に飛ぶのを防ぐ） */
const STALE_HOURS = 12;
/** 送信中のまま止まったものを拾い直すまでの時間 */
const STUCK_MINUTES = 15;

interface DueRow {
  id: number;
  scheduleId: number;
  offsetMinutes: number;
  attempts: number;
  title: string;
  detail: string | null;
  scheduledOn: string;
  startMinutes: number | null;
  audience: string;
  createdBy: number | null;
}

async function claimDue(): Promise<DueRow[]> {
  const pool = await getPool();

  // 取り出しと状態変更を1文で行い、別の実行と取り合わないようにする。
  // 送信中に落ちて sending のまま残ったものは、一定時間後に拾い直す。
  const claimed = await pool
    .request()
    .input('limit', sql.Int, BATCH_SIZE)
    .input('stale', sql.Int, STALE_HOURS)
    .input('max', sql.Int, MAX_ATTEMPTS)
    .input('stuck', sql.Int, STUCK_MINUTES)
    .query(`
      UPDATE TOP (@limit) r
         SET r.status = N'sending',
             r.attempts = r.attempts + 1,
             r.claimed_at = SYSUTCDATETIME()
        OUTPUT INSERTED.id
        FROM dbo.schedule_reminders r
        JOIN dbo.schedules s ON s.id = r.schedule_id
       WHERE r.send_at <= SYSUTCDATETIME()
         AND r.send_at >= DATEADD(hour, -@stale, SYSUTCDATETIME())
         AND r.attempts < @max
         AND s.is_deleted = 0
         AND (r.status = N'pending'
              OR (r.status = N'sending'
                  AND r.claimed_at < DATEADD(minute, -@stuck, SYSUTCDATETIME())))
    `);

  const ids = claimed.recordset.map((row) => num(row.id));
  if (ids.length === 0) return [];

  // 取り出した ID は数値であることを確かめてあるので IN 句へ直接埋めてよい
  const r = await pool.request().query(`
    SELECT r.id, r.schedule_id, r.offset_minutes, r.attempts,
           s.title, s.detail, s.scheduled_on, s.start_minutes, s.audience, s.created_by
      FROM dbo.schedule_reminders r
      JOIN dbo.schedules s ON s.id = r.schedule_id
     WHERE r.id IN (${ids.join(',')})
  `);

  return r.recordset.map((row) => ({
    id: num(row.id),
    scheduleId: num(row.schedule_id),
    offsetMinutes: num(row.offset_minutes),
    attempts: num(row.attempts),
    title: row.title,
    detail: row.detail,
    scheduledOn:
      row.scheduled_on instanceof Date
        ? row.scheduled_on.toISOString().slice(0, 10)
        : String(row.scheduled_on).slice(0, 10),
    startMinutes: row.start_minutes === null ? null : num(row.start_minutes),
    audience: row.audience,
    createdBy: row.created_by === null ? null : num(row.created_by),
  }));
}

/** 宛先。予定ごとの設定で、作成者だけか世帯全員かが決まる */
async function recipients(row: DueRow): Promise<{ address: string; displayName: string }[]> {
  const pool = await getPool();
  const request = pool.request().input('sid', sql.BigInt, row.scheduleId);

  const r = await request.query(`
    SELECT u.email, u.display_name
      FROM dbo.users u
      JOIN dbo.schedules s ON s.household_id = u.household_id
     WHERE s.id = @sid
       AND u.is_active = 1
       AND u.email IS NOT NULL
       AND (s.audience = N'household' OR u.id = s.created_by)
  `);

  return r.recordset.map((u) => ({ address: u.email, displayName: u.display_name }));
}

function buildMail(row: DueRow) {
  const when = formatMoment(row.scheduledOn, row.startMinutes);
  const lead = formatOffset(row.offsetMinutes);
  const url = `${process.env.APP_BASE_URL ?? ''}/calendar/${row.scheduledOn.slice(0, 7)}?d=${row.scheduledOn}`;

  const text = [
    `${row.title}`,
    ``,
    `${when}（${lead}のお知らせ）`,
    row.detail ? `\n${row.detail}` : '',
    ``,
    url ? `カレンダーで見る: ${url}` : '',
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    subject: `【KakeiFlow】${row.title} ${when}`,
    text,
  };
}

async function markSent(id: number): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('id', sql.BigInt, id)
    .query(
      `UPDATE dbo.schedule_reminders
          SET status = N'sent', sent_at = SYSUTCDATETIME(), last_error = NULL
        WHERE id = @id`
    );
}

/** 失敗。上限に達していなければ pending に戻して次回に回す */
async function markFailed(id: number, attempts: number, message: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('id', sql.BigInt, id)
    .input('status', sql.NVarChar(12), attempts >= MAX_ATTEMPTS ? 'failed' : 'pending')
    .input('err', sql.NVarChar(400), message.slice(0, 400))
    .query(
      `UPDATE dbo.schedule_reminders SET status = @status, last_error = @err WHERE id = @id`
    );
}

app.timer('reminderSweep', {
  schedule: '0 */5 * * * *',
  handler: async (_timer: Timer, ctx: InvocationContext) => {
    if (!isEmailConfigured()) {
      ctx.warn('ACS が未設定のため通知を送りません');
      return;
    }

    let due: DueRow[];
    try {
      due = await claimDue();
    } catch (err) {
      ctx.error(`通知の取り出しに失敗: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (due.length === 0) return;
    ctx.log(`通知 ${due.length} 件を送信します`);

    for (const row of due) {
      try {
        const to = await recipients(row);
        if (to.length === 0) {
          // 宛先が無いのは失敗ではない。送ったことにして次へ進める
          await markSent(row.id);
          continue;
        }
        const mail = buildMail(row);
        await sendMail({ to, ...mail });
        await markSent(row.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.error(`通知 ${row.id} の送信に失敗: ${message}`);
        await markFailed(row.id, row.attempts, message).catch(() => undefined);
      }
    }
  },
});
