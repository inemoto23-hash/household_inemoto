/**
 * 買い物メモ。
 *
 * 日付にぶら下がる ToDo リスト。品名とチェックだけを持ち、
 * entries とは一切接続しない。残高にも予算にも影響しない。
 *
 * 予定（schedules）と置き場所は隣だが、テーブルは分けてある。
 * 予定は時刻・通知の宛先・通知予約を持ち、こちらはどれも持たない。
 *
 * どの操作も1文で完結し、対で書く相手がいないのでトランザクションは張らない。
 * 世帯の絞り込みは必ず WHERE の household_id で行う。
 */
import { app } from '@azure/functions';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import {
  MAX_ITEM_NAME,
  shoppingItemInputSchema,
  shoppingItemPatchSchema,
} from '../domain/shopping';

const SELECT_ITEM = `
  SELECT i.id, i.planned_on, i.name, i.is_checked,
         i.created_by, cu.display_name AS created_by_name
    FROM dbo.shopping_items i
    LEFT JOIN dbo.users cu ON cu.id = i.created_by
`;

function mapItem(row: Record<string, any>) {
  return {
    id: num(row.id),
    plannedOn:
      row.planned_on instanceof Date
        ? row.planned_on.toISOString().slice(0, 10)
        : String(row.planned_on).slice(0, 10),
    name: row.name,
    isChecked: row.is_checked,
    createdBy: numOrNull(row.created_by),
    createdByName: row.created_by_name,
  };
}

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------
// 一覧。並びは id 昇順（追加順）で固定する。
// チェックしても位置を動かさない。押した項目が目の前で飛ぶと、
// 続けて押すときに1つ下を押してしまう
// ---------------------------------------------------------------
app.http('shoppingList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'shopping',
  handler: withAuth(async (req, ctx, { user }) => {
    const from = req.query.get('from');
    const to = req.query.get('to');
    if (!from || !to || !DATE_FORMAT.test(from) || !DATE_FORMAT.test(to)) {
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
          `${SELECT_ITEM}
            WHERE i.household_id = @hid
              AND i.planned_on >= @from AND i.planned_on <= @to
            ORDER BY i.planned_on, i.id`
        );

      return ok(r.recordset.map(mapItem));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 追加
// ---------------------------------------------------------------
app.http('shoppingCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'shopping',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = shoppingItemInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;

    try {
      const pool = await getPool();
      const r = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('on', sql.Date, input.plannedOn)
        .input('name', sql.NVarChar(MAX_ITEM_NAME), input.name)
        .input('by', sql.BigInt, user.id)
        .query(
          `INSERT INTO dbo.shopping_items (household_id, planned_on, name, created_by)
           OUTPUT INSERTED.id
           VALUES (@hid, @on, @name, @by)`
        );

      const id = num(r.recordset[0].id);
      const created = await pool
        .request()
        .input('id', sql.BigInt, id)
        .query(`${SELECT_ITEM} WHERE i.id = @id`);

      return ok(mapItem(created.recordset[0]), 201);
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// チェックの切り替え。品名は直せない（消して足し直す）
// ---------------------------------------------------------------
app.http('shoppingUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'shopping/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'IDが不正です');

    const parsed = shoppingItemPatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }

    try {
      const pool = await getPool();
      const r = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .input('checked', sql.Bit, parsed.data.isChecked)
        .query(
          `UPDATE dbo.shopping_items
              SET is_checked = @checked, updated_at = SYSUTCDATETIME()
            WHERE id = @id AND household_id = @hid`
        );

      if (r.rowsAffected[0] === 0) return fail(404, 'NOT_FOUND', '買い物メモが見つかりません');

      const updated = await pool
        .request()
        .input('id', sql.BigInt, id)
        .query(`${SELECT_ITEM} WHERE i.id = @id`);

      return ok(mapItem(updated.recordset[0]));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 削除。使い捨てのメモなので物理削除でよい。
// 論理削除にする理由（他から FK で指される）が無い
// ---------------------------------------------------------------
app.http('shoppingDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'shopping/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'IDが不正です');

    try {
      const pool = await getPool();
      const r = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(`DELETE FROM dbo.shopping_items WHERE id = @id AND household_id = @hid`);

      if (r.rowsAffected[0] === 0) return fail(404, 'NOT_FOUND', '買い物メモが見つかりません');

      return ok({ id, deleted: true });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
