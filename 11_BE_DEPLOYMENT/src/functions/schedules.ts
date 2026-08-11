/**
 * 予定メモ。
 *
 * 家計の記録とは別の台帳に持つ。予定は残高にも予算にも影響しないため、
 * entries に混ぜると集計のたびに除外条件が要る。
 *
 * 通知は予約テーブルへ書き出す。予定を直したら、
 * まだ送っていない予約を作り直す（送信済みには触らない）。
 */
import { app } from '@azure/functions';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import { scheduleInputSchema, reminderSendAt, ScheduleInput } from '../domain/schedule';

const SELECT_SCHEDULE = `
  SELECT s.id, s.scheduled_on, s.start_minutes, s.title, s.detail,
         s.audience, s.color, s.is_done,
         s.created_by, cu.display_name AS created_by_name,
         s.created_at, s.updated_at
    FROM dbo.schedules s
    LEFT JOIN dbo.users cu ON cu.id = s.created_by
`;

function mapSchedule(row: Record<string, any>, reminders: number[]) {
  return {
    id: num(row.id),
    scheduledOn:
      row.scheduled_on instanceof Date
        ? row.scheduled_on.toISOString().slice(0, 10)
        : String(row.scheduled_on).slice(0, 10),
    startMinutes: numOrNull(row.start_minutes),
    title: row.title,
    detail: row.detail,
    audience: row.audience,
    color: row.color,
    isDone: row.is_done,
    createdBy: numOrNull(row.created_by),
    createdByName: row.created_by_name,
    reminders,
  };
}

/**
 * 通知予約を作り直す。
 * 送信済みのものは履歴として残し、まだ送っていないものだけ入れ替える。
 * 既に過ぎている時刻は入れない（保存した瞬間に過去の通知が飛ぶのを防ぐ）。
 */
async function rebuildReminders(
  transaction: sql.Transaction,
  scheduleId: number,
  householdId: number,
  input: Pick<ScheduleInput, 'scheduledOn' | 'startMinutes' | 'reminders'>
): Promise<void> {
  await new sql.Request(transaction)
    .input('sid', sql.BigInt, scheduleId)
    .query(
      `DELETE FROM dbo.schedule_reminders WHERE schedule_id = @sid AND status = N'pending'`
    );

  const offsets = [...new Set(input.reminders ?? [])];
  const now = Date.now();

  for (const offset of offsets) {
    const sendAt = reminderSendAt(input.scheduledOn, input.startMinutes ?? null, offset);
    if (sendAt.getTime() <= now) continue;

    await new sql.Request(transaction)
      .input('sid', sql.BigInt, scheduleId)
      .input('hid', sql.BigInt, householdId)
      .input('offset', sql.Int, offset)
      .input('send_at', sql.DateTime2, sendAt)
      .query(
        `INSERT INTO dbo.schedule_reminders (schedule_id, household_id, offset_minutes, send_at)
         VALUES (@sid, @hid, @offset, @send_at)`
      );
  }
}

/** 予定に紐づく通知の一覧（送信済みも含めて画面に見せる） */
async function loadReminders(scheduleIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (scheduleIds.length === 0) return map;

  const pool = await getPool();
  const r = await pool
    .request()
    // scheduleIds は数値であることを確かめてから渡している
    .query(
      `SELECT schedule_id, offset_minutes
         FROM dbo.schedule_reminders
        WHERE schedule_id IN (${scheduleIds.join(',')})
          AND status IN (N'pending', N'sent')
        ORDER BY offset_minutes DESC`
    );

  for (const row of r.recordset) {
    const id = num(row.schedule_id);
    const list = map.get(id) ?? [];
    list.push(num(row.offset_minutes));
    map.set(id, list);
  }
  return map;
}

// ---------------------------------------------------------------
// 一覧
// ---------------------------------------------------------------
app.http('schedulesList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'schedules',
  handler: withAuth(async (req, ctx, { user }) => {
    const from = req.query.get('from');
    const to = req.query.get('to');
    const dateFormat = /^\d{4}-\d{2}-\d{2}$/;
    if (!from || !to || !dateFormat.test(from) || !dateFormat.test(to)) {
      return fail(400, 'VALIDATION_ERROR', '期間は YYYY-MM-DD 形式で指定してください');
    }

    try {
      const pool = await getPool();
      const r = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('from', sql.Date, from)
        .input('to', sql.Date, to)
        .query(
          `${SELECT_SCHEDULE}
            WHERE s.household_id = @hid AND s.is_deleted = 0
              AND s.scheduled_on >= @from AND s.scheduled_on <= @to
            ORDER BY s.scheduled_on,
                     CASE WHEN s.start_minutes IS NULL THEN 0 ELSE 1 END,
                     s.start_minutes, s.id`
        );

      const ids = r.recordset.map((row) => num(row.id));
      const reminders = await loadReminders(ids);

      return ok(r.recordset.map((row) => mapSchedule(row, reminders.get(num(row.id)) ?? [])));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 登録
// ---------------------------------------------------------------
app.http('schedulesCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'schedules',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = scheduleInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);

    try {
      await transaction.begin();

      const inserted = await new sql.Request(transaction)
        .input('hid', sql.BigInt, user.householdId)
        .input('on', sql.Date, input.scheduledOn)
        .input('start', sql.SmallInt, input.startMinutes ?? null)
        .input('title', sql.NVarChar(120), input.title)
        .input('detail', sql.NVarChar(2000), input.detail ?? null)
        .input('audience', sql.NVarChar(10), input.audience)
        .input('color', sql.NVarChar(20), input.color ?? null)
        .input('by', sql.BigInt, user.id)
        .query(
          `INSERT INTO dbo.schedules
             (household_id, scheduled_on, start_minutes, title, detail, audience, color, created_by)
           OUTPUT INSERTED.id
           VALUES (@hid, @on, @start, @title, @detail, @audience, @color, @by)`
        );

      const id = num(inserted.recordset[0].id);
      await rebuildReminders(transaction, id, user.householdId, input);
      await transaction.commit();

      const created = await pool
        .request()
        .input('id', sql.BigInt, id)
        .query(`${SELECT_SCHEDULE} WHERE s.id = @id`);
      const reminders = await loadReminders([id]);

      return ok(mapSchedule(created.recordset[0], reminders.get(id) ?? []), 201);
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 更新
// ---------------------------------------------------------------
app.http('schedulesUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'schedules/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'IDが不正です');

    const parsed = scheduleInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);

    try {
      const existing = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `SELECT TOP 1 1 AS ok FROM dbo.schedules
            WHERE id = @id AND household_id = @hid AND is_deleted = 0`
        );
      if (!existing.recordset[0]) return fail(404, 'NOT_FOUND', '予定が見つかりません');

      await transaction.begin();

      await new sql.Request(transaction)
        .input('id', sql.BigInt, id)
        .input('on', sql.Date, input.scheduledOn)
        .input('start', sql.SmallInt, input.startMinutes ?? null)
        .input('title', sql.NVarChar(120), input.title)
        .input('detail', sql.NVarChar(2000), input.detail ?? null)
        .input('audience', sql.NVarChar(10), input.audience)
        .input('color', sql.NVarChar(20), input.color ?? null)
        .input('done', sql.Bit, input.isDone ?? false)
        .query(
          `UPDATE dbo.schedules
              SET scheduled_on = @on, start_minutes = @start, title = @title, detail = @detail,
                  audience = @audience, color = @color, is_done = @done,
                  updated_at = SYSUTCDATETIME()
            WHERE id = @id`
        );

      await rebuildReminders(transaction, id, user.householdId, input);
      await transaction.commit();

      const updated = await pool
        .request()
        .input('id', sql.BigInt, id)
        .query(`${SELECT_SCHEDULE} WHERE s.id = @id`);
      const reminders = await loadReminders([id]);

      return ok(mapSchedule(updated.recordset[0], reminders.get(id) ?? []));
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 削除（論理削除）。未送信の通知も止める
// ---------------------------------------------------------------
app.http('schedulesDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'schedules/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'IDが不正です');

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);

    try {
      await transaction.begin();

      const r = await new sql.Request(transaction)
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `UPDATE dbo.schedules SET is_deleted = 1, updated_at = SYSUTCDATETIME()
            WHERE id = @id AND household_id = @hid AND is_deleted = 0`
        );

      if (r.rowsAffected[0] === 0) {
        await transaction.rollback();
        return fail(404, 'NOT_FOUND', '予定が見つかりません');
      }

      await new sql.Request(transaction)
        .input('id', sql.BigInt, id)
        .query(
          `UPDATE dbo.schedule_reminders SET status = N'cancelled'
            WHERE schedule_id = @id AND status = N'pending'`
        );

      await transaction.commit();
      return ok({ id, deleted: true });
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
