/**
 * 取引の登録・検索・更新・削除。
 *
 * 種別ごとの項目整合は domain/entry.ts の normalizeEntry が担保し、
 * 最終防衛線として DB の ck_entries_shape 制約が効く。
 * 画面側の手動クリア処理には依存しない。
 */
import { app } from '@azure/functions';
import { z } from 'zod';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import { entryInputSchema, normalizeEntry, monthRange, NormalizedEntry } from '../domain/entry';

const SELECT_ENTRY = `
  SELECT e.id, e.client_id, e.entry_date, e.kind, e.amount,
         e.budget_category_id, c.name  AS category_name, c.color AS category_color,
         e.account_id,         a.name  AS account_name,
         e.counter_account_id, ca.name AS counter_account_name,
         e.pool_id,            p.name  AS pool_name,
         e.merchant, e.memo, e.place_name,
         e.created_by, cu.display_name AS created_by_name,
         e.created_at, e.updated_at
    FROM dbo.entries e
    LEFT JOIN dbo.budget_categories c  ON c.id  = e.budget_category_id
    LEFT JOIN dbo.accounts a           ON a.id  = e.account_id
    LEFT JOIN dbo.accounts ca          ON ca.id = e.counter_account_id
    LEFT JOIN dbo.pools p              ON p.id  = e.pool_id
    LEFT JOIN dbo.users cu             ON cu.id = e.created_by
`;

function mapEntry(row: Record<string, any>) {
  return {
    id: num(row.id),
    clientId: row.client_id,
    // DATE 型は UTC 起点の Date で返るため、日付部分だけを取り出す
    entryDate: row.entry_date instanceof Date
      ? row.entry_date.toISOString().slice(0, 10)
      : String(row.entry_date).slice(0, 10),
    kind: row.kind,
    amount: num(row.amount),
    budgetCategoryId: numOrNull(row.budget_category_id),
    categoryName: row.category_name,
    categoryColor: row.category_color,
    accountId: numOrNull(row.account_id),
    accountName: row.account_name,
    counterAccountId: numOrNull(row.counter_account_id),
    counterAccountName: row.counter_account_name,
    poolId: numOrNull(row.pool_id),
    poolName: row.pool_name,
    merchant: row.merchant,
    memo: row.memo,
    placeName: row.place_name,
    createdBy: numOrNull(row.created_by),
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 参照先がすべて同じ世帯のものか確かめる。
 * 世帯をまたいだ ID を送り込まれても弾けるようにする。
 */
export async function assertReferencesInHousehold(
  entry: NormalizedEntry,
  householdId: number
): Promise<string | null> {
  const pool = await getPool();

  // mssql の Request は1回しか実行できないため、問い合わせごとに作り直す
  if (entry.budgetCategoryId) {
    const r = await pool
      .request()
      .input('hid', sql.BigInt, householdId)
      .input('cat', sql.BigInt, entry.budgetCategoryId)
      .query(`SELECT TOP 1 1 AS ok FROM dbo.budget_categories WHERE id = @cat AND household_id = @hid`);
    if (!r.recordset[0]) return '指定されたカテゴリが見つかりません';
  }

  const accountIds = [entry.accountId, entry.counterAccountId].filter(
    (v): v is number => v !== null
  );
  if (accountIds.length > 0) {
    const r = await pool
      .request()
      .input('hid', sql.BigInt, householdId)
      .query(
        `SELECT COUNT(*) AS n FROM dbo.accounts
          WHERE household_id = @hid AND id IN (${accountIds.join(',')})`
      );
    if (num(r.recordset[0].n) !== accountIds.length) return '指定された財布が見つかりません';
  }

  if (entry.poolId) {
    const r = await pool
      .request()
      .input('hid', sql.BigInt, householdId)
      .input('pool', sql.BigInt, entry.poolId)
      .query(`SELECT TOP 1 1 AS ok FROM dbo.pools WHERE id = @pool AND household_id = @hid`);
    if (!r.recordset[0]) return '指定されたプールが見つかりません';
  }

  return null;
}

// ---------------------------------------------------------------
// 検索
// ---------------------------------------------------------------
app.http('entriesList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'entries',
  handler: withAuth(async (req, ctx, { user }) => {
    const from = req.query.get('from');
    const to = req.query.get('to');
    const categoryId = req.query.get('categoryId');
    const accountId = req.query.get('accountId');
    const keyword = req.query.get('q');
    const limit = Math.min(Number(req.query.get('limit') ?? 200), 500);

    try {
      const pool = await getPool();
      const request = pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('limit', sql.Int, limit);

      const where = ['e.household_id = @hid', 'e.is_deleted = 0'];

      if (from) {
        where.push('e.entry_date >= @from');
        request.input('from', sql.Date, from);
      }
      if (to) {
        where.push('e.entry_date <= @to');
        request.input('to', sql.Date, to);
      }
      if (categoryId) {
        where.push('e.budget_category_id = @cat');
        request.input('cat', sql.BigInt, Number(categoryId));
      }
      if (accountId) {
        where.push('(e.account_id = @acc OR e.counter_account_id = @acc)');
        request.input('acc', sql.BigInt, Number(accountId));
      }
      if (keyword) {
        where.push('(e.merchant LIKE @kw OR e.memo LIKE @kw)');
        request.input('kw', sql.NVarChar(200), `%${keyword}%`);
      }

      const result = await request.query(
        `${SELECT_ENTRY} WHERE ${where.join(' AND ')}
          ORDER BY e.entry_date DESC, e.id DESC
          OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY`
      );

      return ok(result.recordset.map(mapEntry));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 登録
// ---------------------------------------------------------------
app.http('entriesCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'entries',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = entryInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }

    const normalized = normalizeEntry(parsed.data);
    if (!normalized.ok || !normalized.entry) {
      return fail(400, 'VALIDATION_ERROR', normalized.error ?? '入力内容を確認してください');
    }
    const entry = normalized.entry;

    try {
      const referenceError = await assertReferencesInHousehold(entry, user.householdId);
      if (referenceError) return fail(400, 'VALIDATION_ERROR', referenceError);

      const pool = await getPool();

      // オフラインから再送された場合に二重登録しない
      if (parsed.data.clientId) {
        const existing = await pool
          .request()
          .input('hid', sql.BigInt, user.householdId)
          .input('cid', sql.UniqueIdentifier, parsed.data.clientId)
          .query(`${SELECT_ENTRY} WHERE e.household_id = @hid AND e.client_id = @cid`);
        if (existing.recordset[0]) return ok(mapEntry(existing.recordset[0]), 200);
      }

      const inserted = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('cid', sql.UniqueIdentifier, parsed.data.clientId ?? null)
        .input('date', sql.Date, entry.entryDate)
        .input('kind', sql.NVarChar(10), entry.kind)
        .input('amount', sql.BigInt, entry.amount)
        .input('cat', sql.BigInt, entry.budgetCategoryId)
        .input('acc', sql.BigInt, entry.accountId)
        .input('counter', sql.BigInt, entry.counterAccountId)
        .input('pool', sql.BigInt, entry.poolId)
        .input('merchant', sql.NVarChar(120), entry.merchant)
        .input('memo', sql.NVarChar(500), entry.memo)
        // 位置は取れたら添える。次に同じ場所で記録するときの手がかりになる
        .input('lat', sql.Decimal(9, 6), parsed.data.lat ?? null)
        .input('lng', sql.Decimal(9, 6), parsed.data.lng ?? null)
        .input('acc_m', sql.Int, parsed.data.locationAccuracy ?? null)
        .input('place', sql.NVarChar(120), parsed.data.placeName ?? null)
        .input('by', sql.BigInt, user.id)
        .query(
          `INSERT INTO dbo.entries
             (household_id, client_id, entry_date, kind, amount,
              budget_category_id, account_id, counter_account_id, pool_id,
              merchant, memo, lat, lng, location_accuracy, place_name, created_by)
           OUTPUT INSERTED.id
           VALUES (@hid, @cid, @date, @kind, @amount,
                   @cat, @acc, @counter, @pool,
                   @merchant, @memo, @lat, @lng, @acc_m, @place, @by)`
        );

      const created = await pool
        .request()
        .input('id', sql.BigInt, inserted.recordset[0].id)
        .query(`${SELECT_ENTRY} WHERE e.id = @id`);

      return ok(mapEntry(created.recordset[0]), 201);
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 更新
// ---------------------------------------------------------------
app.http('entriesUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'entries/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return fail(400, 'VALIDATION_ERROR', '取引IDが不正です');
    }

    try {
      const pool = await getPool();
      const current = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(`${SELECT_ENTRY} WHERE e.id = @id AND e.household_id = @hid AND e.is_deleted = 0`);

      if (!current.recordset[0]) return fail(404, 'NOT_FOUND', '取引が見つかりません');
      const before = mapEntry(current.recordset[0]);

      // 現在値に差分を重ねてから種別ごとに正規化する。
      // 種別を変えた場合、前の種別の項目はここで確実に落ちる。
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください');

      const merged = {
        entryDate: before.entryDate,
        kind: before.kind,
        amount: before.amount,
        budgetCategoryId: before.budgetCategoryId,
        accountId: before.accountId,
        counterAccountId: before.counterAccountId,
        poolId: before.poolId,
        merchant: before.merchant,
        memo: before.memo,
        ...body,
      };

      const parsed = entryInputSchema.safeParse(merged);
      if (!parsed.success) {
        return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
      }

      const normalized = normalizeEntry(parsed.data);
      if (!normalized.ok || !normalized.entry) {
        return fail(400, 'VALIDATION_ERROR', normalized.error ?? '入力内容を確認してください');
      }
      const entry = normalized.entry;

      const referenceError = await assertReferencesInHousehold(entry, user.householdId);
      if (referenceError) return fail(400, 'VALIDATION_ERROR', referenceError);

      await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('date', sql.Date, entry.entryDate)
        .input('kind', sql.NVarChar(10), entry.kind)
        .input('amount', sql.BigInt, entry.amount)
        .input('cat', sql.BigInt, entry.budgetCategoryId)
        .input('acc', sql.BigInt, entry.accountId)
        .input('counter', sql.BigInt, entry.counterAccountId)
        .input('pool', sql.BigInt, entry.poolId)
        .input('merchant', sql.NVarChar(120), entry.merchant)
        .input('memo', sql.NVarChar(500), entry.memo)
        .query(
          `UPDATE dbo.entries
              SET entry_date = @date, kind = @kind, amount = @amount,
                  budget_category_id = @cat, account_id = @acc,
                  counter_account_id = @counter, pool_id = @pool,
                  merchant = @merchant, memo = @memo,
                  updated_at = SYSUTCDATETIME()
            WHERE id = @id`
        );

      const updated = await pool
        .request()
        .input('id', sql.BigInt, id)
        .query(`${SELECT_ENTRY} WHERE e.id = @id`);

      return ok(mapEntry(updated.recordset[0]));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 削除（論理削除）と復元
// ---------------------------------------------------------------
app.http('entriesDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'entries/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return fail(400, 'VALIDATION_ERROR', '取引IDが不正です');
    }

    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `UPDATE dbo.entries SET is_deleted = 1, updated_at = SYSUTCDATETIME()
            OUTPUT INSERTED.id
            WHERE id = @id AND household_id = @hid AND is_deleted = 0`
        );

      if (!result.recordset[0]) return fail(404, 'NOT_FOUND', '取引が見つかりません');
      return ok({ id, isDeleted: true });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('entriesRestore', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'entries/{id}/restore',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return fail(400, 'VALIDATION_ERROR', '取引IDが不正です');
    }

    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `UPDATE dbo.entries SET is_deleted = 0, updated_at = SYSUTCDATETIME()
            OUTPUT INSERTED.id
            WHERE id = @id AND household_id = @hid AND is_deleted = 1`
        );

      if (!result.recordset[0]) return fail(404, 'NOT_FOUND', '取引が見つかりません');

      const restored = await pool
        .request()
        .input('id', sql.BigInt, id)
        .query(`${SELECT_ENTRY} WHERE e.id = @id`);

      return ok(mapEntry(restored.recordset[0]));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// カレンダー用の日別集計
// ---------------------------------------------------------------
app.http('calendarMonth', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'calendar/{ym}',
  handler: withAuth(async (req, ctx, { user }) => {
    const range = monthRange(req.params.ym);
    if (!range) return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');

    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('from', sql.Date, range.from)
        .input('to', sql.Date, range.toExclusive)
        .query(
          `SELECT e.entry_date,
                  SUM(CASE WHEN e.kind = 'expense' THEN e.amount ELSE 0 END) AS expense,
                  SUM(CASE WHEN e.kind = 'income'  THEN e.amount ELSE 0 END) AS income,
                  SUM(CASE WHEN e.kind = 'refund'  THEN e.amount ELSE 0 END) AS refund,
                  SUM(CASE WHEN e.kind = 'transfer' THEN 1 ELSE 0 END)       AS transfer_count,
                  COUNT(*) AS entry_count
             FROM dbo.entries e
            WHERE e.household_id = @hid
              AND e.is_deleted = 0
              AND e.entry_date >= @from AND e.entry_date < @to
            GROUP BY e.entry_date
            ORDER BY e.entry_date;

           -- 予定のある日を印で出すために、日別の件数も一緒に返す
           SELECT s.scheduled_on, COUNT(*) AS n
             FROM dbo.schedules s
            WHERE s.household_id = @hid
              AND s.is_deleted = 0
              AND s.scheduled_on >= @from AND s.scheduled_on < @to
            GROUP BY s.scheduled_on`
        );

      const [entryRows, scheduleRows] = result.recordsets as any[];

      const scheduleCounts = new Map<string, number>();
      for (const row of scheduleRows) {
        const key =
          row.scheduled_on instanceof Date
            ? row.scheduled_on.toISOString().slice(0, 10)
            : String(row.scheduled_on).slice(0, 10);
        scheduleCounts.set(key, num(row.n));
      }

      const days = entryRows.map((row: Record<string, any>) => {
        const expense = num(row.expense);
        const refund = num(row.refund);
        const income = num(row.income);
        const date =
          row.entry_date instanceof Date
            ? row.entry_date.toISOString().slice(0, 10)
            : String(row.entry_date).slice(0, 10);
        return {
          date,
          // 返金は支出を戻すもの。収入には混ぜない
          expense: expense - refund,
          income,
          transferCount: num(row.transfer_count),
          entryCount: num(row.entry_count),
          scheduleCount: scheduleCounts.get(date) ?? 0,
        };
      });

      // 取引が1件も無いが予定だけある日も、印を出すために返す
      const known = new Set(days.map((d: { date: string }) => d.date));
      for (const [date, n] of scheduleCounts) {
        if (known.has(date)) continue;
        days.push({
          date,
          expense: 0,
          income: 0,
          transferCount: 0,
          entryCount: 0,
          scheduleCount: n,
        });
      }
      days.sort((a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date));

      return ok({
        yearMonth: req.params.ym,
        days,
        total: {
          expense: days.reduce((s: number, d: { expense: number }) => s + d.expense, 0),
          income: days.reduce((s: number, d: { income: number }) => s + d.income, 0),
          entryCount: days.reduce((s: number, d: { entryCount: number }) => s + d.entryCount, 0),
        },
      });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
