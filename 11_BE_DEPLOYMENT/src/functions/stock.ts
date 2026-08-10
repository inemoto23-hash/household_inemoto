/**
 * レコードストック（クイック登録）。
 *
 * レジの前で分類まで決めさせない。金額だけ受け取って即座に保存し、
 * カテゴリ・財布は後からまとめて確定する。
 *
 * 確定するまでは entries に入らないため、残高にも予算にも影響しない。
 * 「とりあえず記録した額」が集計を汚さないことが、この機能の前提になる。
 *
 * 位置情報は取れたら残す。取れなくても登録は成立する。
 * 過去に同じ場所で記録した実績があれば、そこから分類を推測して初期値にする。
 */
import { app } from '@azure/functions';
import { z } from 'zod';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import { entryInputSchema, normalizeEntry } from '../domain/entry';
import { assertReferencesInHousehold } from './entries';

/**
 * 「同じ場所」とみなす緯度経度の幅。
 * 0.0015度は日本付近で概ね 140〜170m。店舗を特定するには十分で、
 * GPS の誤差（屋内で数十m）に埋もれない程度の広さ。
 */
const NEARBY_DEGREES = 0.0015;

const SELECT_STOCK = `
  SELECT s.id, s.client_id, s.raw_text, s.amount, s.entry_date, s.captured_at,
         s.suggested_kind, s.suggestion_reason,
         s.suggested_category_id, c.name AS category_name, c.color AS category_color,
         s.suggested_account_id,  a.name AS account_name,
         s.suggested_pool_id,     p.name AS pool_name,
         s.lat, s.lng, s.location_accuracy, s.place_name,
         s.source, s.status,
         s.created_by, cu.display_name AS created_by_name
    FROM dbo.entry_stock s
    LEFT JOIN dbo.budget_categories c ON c.id = s.suggested_category_id
    LEFT JOIN dbo.accounts a          ON a.id = s.suggested_account_id
    LEFT JOIN dbo.pools p             ON p.id = s.suggested_pool_id
    LEFT JOIN dbo.users cu            ON cu.id = s.created_by
`;

function mapStock(row: Record<string, any>) {
  return {
    id: num(row.id),
    clientId: row.client_id,
    rawText: row.raw_text,
    amount: numOrNull(row.amount),
    entryDate:
      row.entry_date instanceof Date
        ? row.entry_date.toISOString().slice(0, 10)
        : row.entry_date
          ? String(row.entry_date).slice(0, 10)
          : null,
    capturedAt: row.captured_at,
    suggestedKind: row.suggested_kind,
    suggestionReason: row.suggestion_reason,
    suggestedCategoryId: numOrNull(row.suggested_category_id),
    categoryName: row.category_name,
    categoryColor: row.category_color,
    suggestedAccountId: numOrNull(row.suggested_account_id),
    accountName: row.account_name,
    suggestedPoolId: numOrNull(row.suggested_pool_id),
    poolName: row.pool_name,
    // DECIMAL は文字列で返るので数値へ寄せる
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    locationAccuracy: numOrNull(row.location_accuracy),
    placeName: row.place_name,
    source: row.source,
    status: row.status,
    createdBy: numOrNull(row.created_by),
    createdByName: row.created_by_name,
  };
}

/**
 * 同じ場所での過去の記録から分類を推測する。
 * 回数の多いものを優先し、同数なら直近を採る。
 */
async function guessFromPlace(
  householdId: number,
  lat: number,
  lng: number
): Promise<{
  categoryId: number | null;
  accountId: number | null;
  merchant: string | null;
  placeName: string | null;
  count: number;
} | null> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .input('lat', sql.Decimal(9, 6), lat)
    .input('lng', sql.Decimal(9, 6), lng)
    .input('d', sql.Decimal(9, 6), NEARBY_DEGREES)
    .query(
      `SELECT TOP 1
              e.budget_category_id, e.account_id, e.merchant, e.place_name,
              COUNT(*) AS n
         FROM dbo.entries e
        WHERE e.household_id = @hid
          AND e.is_deleted = 0
          AND e.kind = N'expense'
          AND e.lat IS NOT NULL AND e.lng IS NOT NULL
          AND e.lat BETWEEN @lat - @d AND @lat + @d
          AND e.lng BETWEEN @lng - @d AND @lng + @d
        GROUP BY e.budget_category_id, e.account_id, e.merchant, e.place_name
        ORDER BY COUNT(*) DESC, MAX(e.entry_date) DESC`
    );

  const row = r.recordset[0];
  if (!row) return null;
  return {
    categoryId: numOrNull(row.budget_category_id),
    accountId: numOrNull(row.account_id),
    merchant: row.merchant,
    placeName: row.place_name,
    count: num(row.n),
  };
}

// ---------------------------------------------------------------
// 未確定の一覧
// ---------------------------------------------------------------
app.http('stockList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'stock',
  handler: withAuth(async (_req, ctx, { user }) => {
    try {
      const pool = await getPool();
      const r = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `${SELECT_STOCK}
            WHERE s.household_id = @hid AND s.status = N'pending'
            ORDER BY s.captured_at DESC`
        );
      return ok(r.recordset.map(mapStock));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// クイック登録
// ---------------------------------------------------------------
const stockCreateSchema = z.object({
  amount: z.coerce.number().int().positive('金額は1円以上で入力してください'),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  rawText: z.string().trim().max(500).nullable().optional(),
  /** 位置情報。取得できなければ送らなくてよい */
  lat: z.coerce.number().min(-90).max(90).nullable().optional(),
  lng: z.coerce.number().min(-180).max(180).nullable().optional(),
  locationAccuracy: z.coerce.number().int().min(0).nullable().optional(),
  /** 同じ端末からの二重送信を弾く */
  clientId: z.string().uuid().nullable().optional(),
});

app.http('stockCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'stock',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = stockCreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;

    try {
      const pool = await getPool();

      // 同じ clientId が既にあれば、それをそのまま返す。
      // 電波が悪いところで二度押ししても二重に増えない
      if (input.clientId) {
        const dup = await pool
          .request()
          .input('hid', sql.BigInt, user.householdId)
          .input('cid', sql.UniqueIdentifier, input.clientId)
          .query(`${SELECT_STOCK} WHERE s.household_id = @hid AND s.client_id = @cid`);
        if (dup.recordset[0]) return ok(mapStock(dup.recordset[0]));
      }

      // 位置が取れていれば、同じ場所での過去の記録から分類を推測する
      const guess =
        input.lat != null && input.lng != null
          ? await guessFromPlace(user.householdId, input.lat, input.lng)
          : null;

      const reason = guess
        ? `この場所で過去に${guess.count}件${guess.merchant ? `（${guess.merchant}）` : ''}`
        : null;

      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('cid', sql.UniqueIdentifier, input.clientId ?? null)
        .input('raw', sql.NVarChar(500), input.rawText ?? null)
        .input('amount', sql.BigInt, input.amount)
        .input('date', sql.Date, input.entryDate ?? null)
        .input('kind', sql.NVarChar(10), 'expense')
        .input('cat', sql.BigInt, guess?.categoryId ?? null)
        .input('acc', sql.BigInt, guess?.accountId ?? null)
        .input('reason', sql.NVarChar(200), reason)
        .input('lat', sql.Decimal(9, 6), input.lat ?? null)
        .input('lng', sql.Decimal(9, 6), input.lng ?? null)
        .input('acc_m', sql.Int, input.locationAccuracy ?? null)
        .input('place', sql.NVarChar(120), guess?.placeName ?? guess?.merchant ?? null)
        .input('by', sql.BigInt, user.id)
        .query(
          `INSERT INTO dbo.entry_stock
             (household_id, client_id, raw_text, amount, entry_date,
              suggested_kind, suggested_category_id, suggested_account_id, suggestion_reason,
              lat, lng, location_accuracy, place_name, source, created_by)
           OUTPUT INSERTED.id
           VALUES (@hid, @cid, @raw, @amount, @date,
                   @kind, @cat, @acc, @reason,
                   @lat, @lng, @acc_m, @place, N'quick', @by)`
        );

      const created = await pool
        .request()
        .input('id', sql.BigInt, num(result.recordset[0].id))
        .query(`${SELECT_STOCK} WHERE s.id = @id`);

      return ok(mapStock(created.recordset[0]), 201);
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 下書きの編集（確定前に少しずつ埋めていける）
// ---------------------------------------------------------------
const stockUpdateSchema = z
  .object({
    amount: z.coerce.number().int().positive(),
    entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rawText: z.string().trim().max(500).nullable(),
    placeName: z.string().trim().max(120).nullable(),
    suggestedCategoryId: z.coerce.number().int().positive().nullable(),
    suggestedAccountId: z.coerce.number().int().positive().nullable(),
    suggestedPoolId: z.coerce.number().int().positive().nullable(),
  })
  .partial();

app.http('stockUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'stock/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'IDが不正です');

    const parsed = stockUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }

    try {
      const pool = await getPool();
      const request = pool.request().input('id', sql.BigInt, id).input('hid', sql.BigInt, user.householdId);
      const sets: string[] = [];
      const put = (key: string, column: string, type: any, value: any) => {
        if (value === undefined) return;
        request.input(key, type, value);
        sets.push(`${column} = @${key}`);
      };

      put('amount', 'amount', sql.BigInt, parsed.data.amount);
      put('date', 'entry_date', sql.Date, parsed.data.entryDate);
      put('raw', 'raw_text', sql.NVarChar(500), parsed.data.rawText);
      put('place', 'place_name', sql.NVarChar(120), parsed.data.placeName);
      put('cat', 'suggested_category_id', sql.BigInt, parsed.data.suggestedCategoryId);
      put('acc', 'suggested_account_id', sql.BigInt, parsed.data.suggestedAccountId);
      put('pool_id', 'suggested_pool_id', sql.BigInt, parsed.data.suggestedPoolId);

      if (sets.length === 0) return ok({ id, changed: false });

      const r = await request.query(
        `UPDATE dbo.entry_stock SET ${sets.join(', ')}
          WHERE id = @id AND household_id = @hid AND status = N'pending'`
      );
      if (r.rowsAffected[0] === 0) {
        return fail(404, 'NOT_FOUND', '未確定の記録が見つかりません');
      }
      return ok({ id, changed: true });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 確定（entries へ移す）
// ---------------------------------------------------------------
const commitSchema = entryInputSchema.extend({
  placeName: z.string().trim().max(120).nullable().optional(),
});

app.http('stockCommit', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'stock/{id}/commit',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'IDが不正です');

    const parsed = commitSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }

    // 種別ごとの項目整合は通常の登録と同じ関数に通す
    const normalized = normalizeEntry(parsed.data);
    if (!normalized.ok || !normalized.entry) {
      return fail(400, 'VALIDATION_ERROR', normalized.error ?? '入力内容を確認してください');
    }
    const entry = normalized.entry;

    const refError = await assertReferencesInHousehold(entry, user.householdId);
    if (refError) return fail(400, 'VALIDATION_ERROR', refError);

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);

    try {
      const stock = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `SELECT lat, lng, location_accuracy, client_id, status
             FROM dbo.entry_stock WHERE id = @id AND household_id = @hid`
        );
      const row = stock.recordset[0];
      if (!row) return fail(404, 'NOT_FOUND', '記録が見つかりません');
      if (row.status !== 'pending') {
        return fail(409, 'ALREADY_COMMITTED', 'この記録はすでに処理済みです');
      }

      await transaction.begin();

      // 位置情報はストックから引き継ぐ。次に同じ場所で登録したとき推測の材料になる
      const inserted = await new sql.Request(transaction)
        .input('hid', sql.BigInt, user.householdId)
        .input('cid', sql.UniqueIdentifier, row.client_id)
        .input('date', sql.Date, entry.entryDate)
        .input('kind', sql.NVarChar(10), entry.kind)
        .input('amount', sql.BigInt, entry.amount)
        .input('cat', sql.BigInt, entry.budgetCategoryId)
        .input('acc', sql.BigInt, entry.accountId)
        .input('counter', sql.BigInt, entry.counterAccountId)
        .input('pool_id', sql.BigInt, entry.poolId)
        .input('merchant', sql.NVarChar(120), entry.merchant)
        .input('memo', sql.NVarChar(500), entry.memo)
        .input('lat', sql.Decimal(9, 6), row.lat)
        .input('lng', sql.Decimal(9, 6), row.lng)
        .input('acc_m', sql.Int, row.location_accuracy)
        .input('place', sql.NVarChar(120), parsed.data.placeName ?? null)
        .input('by', sql.BigInt, user.id)
        .query(
          `INSERT INTO dbo.entries
             (household_id, client_id, entry_date, kind, amount,
              budget_category_id, account_id, counter_account_id, pool_id,
              merchant, memo, lat, lng, location_accuracy, place_name, source, created_by)
           OUTPUT INSERTED.id
           VALUES (@hid, @cid, @date, @kind, @amount,
                   @cat, @acc, @counter, @pool_id,
                   @merchant, @memo, @lat, @lng, @acc_m, @place, N'stock', @by)`
        );

      const entryId = num(inserted.recordset[0].id);

      await new sql.Request(transaction)
        .input('id', sql.BigInt, id)
        .input('eid', sql.BigInt, entryId)
        .query(
          `UPDATE dbo.entry_stock
              SET status = N'committed', committed_entry_id = @eid
            WHERE id = @id AND status = N'pending'`
        );

      await transaction.commit();
      return ok({ id, entryId }, 201);
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 破棄
// ---------------------------------------------------------------
app.http('stockDiscard', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'stock/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'IDが不正です');

    try {
      const pool = await getPool();
      const r = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `UPDATE dbo.entry_stock SET status = N'discarded'
            WHERE id = @id AND household_id = @hid AND status = N'pending'`
        );
      if (r.rowsAffected[0] === 0) {
        return fail(404, 'NOT_FOUND', '未確定の記録が見つかりません');
      }
      return ok({ id, status: 'discarded' });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
