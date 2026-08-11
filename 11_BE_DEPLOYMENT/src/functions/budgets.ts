/**
 * 予算の配分・組み換え・プールの出し入れ。
 *
 * 予算額は UPDATE せず budget_allocations の SUM で導出する。
 * 組み換えは -N と +N を1トランザクションで挿入するだけなので、
 * 総額が狂うことが構造的に起きない。取り消しは逆仕訳の追記で行う。
 *
 * プールは月をまたいで累積するため別台帳（pool_movements）に持つ。
 * 予算とプールの間の移動は、両台帳へ対で書き、同じ transfer_group_id で結ぶ。
 */
import { app } from '@azure/functions';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth, AuthedUser } from '../shared/auth';
import { monthRange } from '../domain/entry';

const yearMonthSchema = z.string().regex(/^\d{4}-\d{2}$/);

/** 締めた月は配分を変えられない */
async function assertPeriodOpen(householdId: number, yearMonth: string): Promise<string | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .input('ym', sql.Char(7), yearMonth)
    .query(
      `SELECT TOP 1 status FROM dbo.budget_periods WHERE household_id = @hid AND year_month = @ym`
    );
  const status = result.recordset[0]?.status;
  return status === 'closed' ? 'この月は締め済みのため、予算を変更できません' : null;
}

/**
 * 期間の行が無ければ作る。**配分は入れない。**
 *
 * 翌月の予算は「月を締めたとき」に決まる（periods.ts の seedDefaults）。
 * 開いただけで既定額が入ると、締める前から翌月が確定したように見えてしまい、
 * 締めで繰越を足したときに二重になる。
 */
async function ensurePeriod(householdId: number, yearMonth: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .input('ym', sql.Char(7), yearMonth)
    .query(
      `IF NOT EXISTS (SELECT 1 FROM dbo.budget_periods WHERE household_id = @hid AND year_month = @ym)
         INSERT INTO dbo.budget_periods (household_id, year_month) VALUES (@hid, @ym)`
    );
}

/**
 * 配分台帳の読み分け。
 *
 * 基準額（母数）はその月の計画で、残りを直しても動かさない。
 * 調整は月内の増減で、組み換えやプールの出し入れもここに入る。
 *
 *   残り = 基準額 + 調整 − 消化
 */
const BASELINE_REASONS = `'initial', 'carry_over', 'default'`;

/** 'YYYY-MM' の前月 */
function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

/** カテゴリが同じ世帯のものか */
async function categoryInHousehold(id: number, householdId: number): Promise<boolean> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('id', sql.BigInt, id)
    .input('hid', sql.BigInt, householdId)
    .query(`SELECT TOP 1 1 AS ok FROM dbo.budget_categories WHERE id = @id AND household_id = @hid`);
  return r.recordset.length > 0;
}

// ---------------------------------------------------------------
// 月の予算サマリー
// ---------------------------------------------------------------
app.http('budgetsGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'budgets/{ym}',
  handler: withAuth(async (req, ctx, { user }) => {
    const ym = req.params.ym;
    const range = monthRange(ym);
    if (!range) return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');

    try {
      // 期間の行だけ作る。配分は月を締めたときに決まる
      await ensurePeriod(user.householdId, ym);

      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('ym', sql.Char(7), ym)
        .input('prev', sql.Char(7), prevMonth(ym))
        .input('from', sql.Date, range.from)
        .input('to', sql.Date, range.toExclusive)
        .query(`
          SELECT c.id, c.name, c.kind, c.color, c.icon, c.order_index, c.carry_over_policy,
                 c.default_amount,
                 ISNULL(al.allocated, 0) AS allocated,
                 ISNULL(al.baseline, 0)  AS baseline,
                 ISNULL(sp.spent, 0)     AS spent,
                 ISNULL(co.carried, 0)   AS carried_over
            FROM dbo.budget_categories c
            -- 基準額（母数）と調整を1回の走査で分けて数える
            OUTER APPLY (SELECT SUM(amount) AS allocated,
                                SUM(CASE WHEN ba.reason IN (${BASELINE_REASONS})
                                         THEN amount ELSE 0 END) AS baseline
                           FROM dbo.budget_allocations ba
                          WHERE ba.category_id = c.id AND ba.year_month = @ym) al
            OUTER APPLY (SELECT SUM(amount) AS carried FROM dbo.budget_allocations ba
                          WHERE ba.category_id = c.id AND ba.year_month = @ym
                            AND ba.reason = 'carry_over') co
            OUTER APPLY (SELECT SUM(CASE
                                      WHEN e.kind = 'expense' THEN e.amount
                                      WHEN e.kind = 'refund'  THEN -e.amount
                                      WHEN e.kind = 'income'  THEN e.amount
                                      ELSE 0 END) AS spent
                           FROM dbo.entries e
                          WHERE e.budget_category_id = c.id AND e.is_deleted = 0
                            AND e.entry_date >= @from AND e.entry_date < @to) sp
           WHERE c.household_id = @hid AND c.is_archived = 0
           ORDER BY c.kind DESC, c.order_index, c.name;

          SELECT p.id, p.name, p.purpose, p.target_amount, p.icon, p.color, p.order_index,
                 b.balance,
                 ISNULL(mv.month_in, 0)  AS month_in,
                 ISNULL(mv.month_out, 0) AS month_out
            FROM dbo.pools p
            LEFT JOIN dbo.vw_pool_balances b ON b.pool_id = p.id
            OUTER APPLY (SELECT SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)  AS month_in,
                                SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS month_out
                           FROM dbo.pool_movements m
                          WHERE m.pool_id = p.id AND m.year_month = @ym) mv
           WHERE p.household_id = @hid AND p.is_archived = 0
           ORDER BY p.order_index, p.name;

          SELECT p.status,
                 (SELECT COUNT(*) FROM dbo.budget_allocations ba
                   WHERE ba.household_id = @hid AND ba.year_month = @ym) AS alloc_rows
            FROM dbo.budget_periods p
           WHERE p.household_id = @hid AND p.year_month = @ym;

          -- 未確定のとき「先月を締めてください」と案内するために要る
          SELECT status FROM dbo.budget_periods WHERE household_id = @hid AND year_month = @prev;
        `);

      const [categoryRows, poolRows, periodRows, prevRows] = result.recordsets as any[];

      const categories = categoryRows.map((row: any) => {
        const allocated = num(row.allocated);
        const baseline = num(row.baseline);
        const spent = num(row.spent);
        return {
          id: num(row.id),
          name: row.name,
          kind: row.kind,
          color: row.color,
          icon: row.icon,
          orderIndex: num(row.order_index),
          carryOverPolicy: row.carry_over_policy,
          defaultAmount: num(row.default_amount),
          allocated,
          /** その月の母数。残りを直しても動かない */
          baseline,
          /** 月内の増減（残りの直接指定・組み換え・プールの出し入れ） */
          adjusted: allocated - baseline,
          /** expense は消化額、income は受取額 */
          spent,
          remaining: allocated - spent,
          carriedOver: num(row.carried_over),
        };
      });

      const expense = categories.filter((c: any) => c.kind === 'expense');

      return ok({
        yearMonth: ym,
        status: periodRows[0]?.status ?? 'active',
        /**
         * まだ配分が1行も無い月。
         * 翌月は先月を締めたときに決まるため、締める前はこれが立つ。
         */
        pending: num(periodRows[0]?.alloc_rows) === 0,
        /** 未確定のとき、先に締めるべき月が締まっているか */
        previousMonth: prevMonth(ym),
        previousClosed: prevRows[0]?.status === 'closed',
        categories,
        pools: poolRows.map((row: any) => ({
          id: num(row.id),
          name: row.name,
          purpose: row.purpose,
          targetAmount: numOrNull(row.target_amount),
          icon: row.icon,
          color: row.color,
          orderIndex: num(row.order_index),
          balance: num(row.balance),
          monthIn: num(row.month_in),
          monthOut: num(row.month_out),
        })),
        total: {
          allocated: expense.reduce((s: number, c: any) => s + c.allocated, 0),
          spent: expense.reduce((s: number, c: any) => s + c.spent, 0),
          remaining: expense.reduce((s: number, c: any) => s + c.remaining, 0),
        },
      });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 月初の基本配分（カテゴリごとに「いくらにするか」を指定する）
// ---------------------------------------------------------------
const initialSchema = z.object({
  items: z
    .array(
      z.object({
        categoryId: z.coerce.number().int().positive(),
        amount: z.coerce.number().int().min(0),
      })
    )
    .max(200),
});

app.http('budgetsSetInitial', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'budgets/{ym}/initial',
  handler: withAuth(async (req, ctx, { user }) => {
    const ym = req.params.ym;
    if (!yearMonthSchema.safeParse(ym).success || !monthRange(ym)) {
      return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');
    }

    const parsed = initialSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }

    const closed = await assertPeriodOpen(user.householdId, ym);
    if (closed) return fail(409, 'PERIOD_CLOSED', closed);

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);

    try {
      await ensurePeriod(user.householdId, ym);

      for (const item of parsed.data.items) {
        if (!(await categoryInHousehold(item.categoryId, user.householdId))) {
          return fail(400, 'VALIDATION_ERROR', '指定されたカテゴリが見つかりません');
        }
      }

      await transaction.begin();

      // 配分の設定は上書きとして扱う。
      // 組み換えやプールへの拠出も含めた「その月の配分合計」が
      // 指定された金額そのものになるよう、差分を1行だけ追記する。
      // 台帳は追記専用なので過去の行は書き換えず、経緯は履歴に残る。
      for (const item of parsed.data.items) {
        const current = await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('ym', sql.Char(7), ym)
          .input('cat', sql.BigInt, item.categoryId)
          .query(
            `SELECT ISNULL(SUM(amount), 0) AS total
               FROM dbo.budget_allocations
              WHERE household_id = @hid AND year_month = @ym
                AND category_id = @cat`
          );

        const delta = item.amount - num(current.recordset[0].total);
        if (delta === 0) continue;

        await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('ym', sql.Char(7), ym)
          .input('cat', sql.BigInt, item.categoryId)
          .input('amount', sql.BigInt, delta)
          .input('by', sql.BigInt, user.id)
          .query(
            `INSERT INTO dbo.budget_allocations
               (household_id, year_month, category_id, amount, reason, created_by)
             VALUES (@hid, @ym, @cat, @amount, 'initial', @by)`
          );
      }

      await transaction.commit();
      return ok({ yearMonth: ym, updated: parsed.data.items.length });
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// その月の残りを直接決める
//
// 予算ページはその月の残高をいじる場所であって、母数を決める場所ではない。
// 「予算 20,000 / 残り 15,000」を「残り 10,000」に直したとき、
// 予算は 20,000 のまま、差の -5,000 を調整として1行追記する。
//
// 母数（基準額）は reason が initial / carry_over / default の合計なので、
// adjust を積んでも動かない。経緯は履歴に残る。
// ---------------------------------------------------------------
const remainingSchema = z.object({
  items: z
    .array(
      z.object({
        categoryId: z.coerce.number().int().positive(),
        /** 使いすぎの状態から直すこともあるため、負の値も受ける */
        remaining: z.coerce.number().int(),
      })
    )
    .max(200),
});

app.http('budgetsSetRemaining', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'budgets/{ym}/remaining',
  handler: withAuth(async (req, ctx, { user }) => {
    const ym = req.params.ym;
    const range = monthRange(ym);
    if (!yearMonthSchema.safeParse(ym).success || !range) {
      return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');
    }

    const parsed = remainingSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }

    const closed = await assertPeriodOpen(user.householdId, ym);
    if (closed) return fail(409, 'PERIOD_CLOSED', closed);

    for (const item of parsed.data.items) {
      if (!(await categoryInHousehold(item.categoryId, user.householdId))) {
        return fail(400, 'VALIDATION_ERROR', '指定されたカテゴリが見つかりません');
      }
    }

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);

    try {
      await ensurePeriod(user.householdId, ym);
      await transaction.begin();

      let changed = 0;

      for (const item of parsed.data.items) {
        // 今の配分合計と消化額を同時に取り、残りの差分を出す
        const current = await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('ym', sql.Char(7), ym)
          .input('cat', sql.BigInt, item.categoryId)
          .input('from', sql.Date, range.from)
          .input('to', sql.Date, range.toExclusive)
          .query(
            `SELECT
               (SELECT ISNULL(SUM(amount), 0) FROM dbo.budget_allocations
                 WHERE household_id = @hid AND year_month = @ym AND category_id = @cat) AS allocated,
               (SELECT ISNULL(SUM(CASE
                                    WHEN e.kind = 'expense' THEN e.amount
                                    WHEN e.kind = 'refund'  THEN -e.amount
                                    WHEN e.kind = 'income'  THEN e.amount
                                    ELSE 0 END), 0)
                  FROM dbo.entries e
                 WHERE e.budget_category_id = @cat AND e.is_deleted = 0
                   AND e.entry_date >= @from AND e.entry_date < @to) AS spent`
          );

        const allocated = num(current.recordset[0].allocated);
        const spent = num(current.recordset[0].spent);

        // 残り = 配分 − 消化 なので、望む残りにするための配分は 消化 + 残り
        const delta = spent + item.remaining - allocated;
        if (delta === 0) continue;

        await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('ym', sql.Char(7), ym)
          .input('cat', sql.BigInt, item.categoryId)
          .input('amount', sql.BigInt, delta)
          .input('note', sql.NVarChar(200), `残りを ${item.remaining.toLocaleString('ja-JP')} 円に`)
          .input('by', sql.BigInt, user.id)
          .query(
            `INSERT INTO dbo.budget_allocations
               (household_id, year_month, category_id, amount, reason, note, created_by)
             VALUES (@hid, @ym, @cat, @amount, 'adjust', @note, @by)`
          );
        changed += 1;
      }

      await transaction.commit();
      return ok({ yearMonth: ym, updated: changed });
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// カテゴリ間の組み換え
// ---------------------------------------------------------------
const transferSchema = z.object({
  fromCategoryId: z.coerce.number().int().positive(),
  toCategoryId: z.coerce.number().int().positive(),
  amount: z.coerce.number().int().positive(),
  note: z.string().trim().max(200).optional(),
});

app.http('budgetsTransfer', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'budgets/{ym}/transfer',
  handler: withAuth(async (req, ctx, { user }) => {
    const ym = req.params.ym;
    if (!monthRange(ym)) return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');

    const parsed = transferSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;

    if (input.fromCategoryId === input.toCategoryId) {
      return fail(400, 'VALIDATION_ERROR', '同じカテゴリ同士では移動できません');
    }

    const closed = await assertPeriodOpen(user.householdId, ym);
    if (closed) return fail(409, 'PERIOD_CLOSED', closed);

    try {
      for (const id of [input.fromCategoryId, input.toCategoryId]) {
        if (!(await categoryInHousehold(id, user.householdId))) {
          return fail(400, 'VALIDATION_ERROR', '指定されたカテゴリが見つかりません');
        }
      }

      // 残額が足りなくても止めない。
      // 赤字の月は予算がマイナスになるのが実態であり、
      // 「足りないから動かせない」では、足りない月こそ組み換えできないことになる。
      // マイナスになることは画面側の変更前後プレビューで示す。

      await ensurePeriod(user.householdId, ym);
      await insertAllocationPair({
        householdId: user.householdId,
        yearMonth: ym,
        fromCategoryId: input.fromCategoryId,
        toCategoryId: input.toCategoryId,
        amount: input.amount,
        note: input.note ?? null,
        user,
      });

      return ok({ yearMonth: ym, moved: input.amount });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

/** ±の2行を必ず対で挿入する。同じ transfer_group_id で結び、合計は常に 0 */
async function insertAllocationPair(args: {
  householdId: number;
  yearMonth: string;
  fromCategoryId: number;
  toCategoryId: number;
  amount: number;
  note: string | null;
  user: AuthedUser;
}): Promise<void> {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  const groupId = randomUUID();

  try {
    await transaction.begin();

    for (const [categoryId, signed] of [
      [args.fromCategoryId, -args.amount],
      [args.toCategoryId, args.amount],
    ] as const) {
      await new sql.Request(transaction)
        .input('hid', sql.BigInt, args.householdId)
        .input('ym', sql.Char(7), args.yearMonth)
        .input('cat', sql.BigInt, categoryId)
        .input('amount', sql.BigInt, signed)
        .input('group', sql.UniqueIdentifier, groupId)
        .input('note', sql.NVarChar(200), args.note)
        .input('by', sql.BigInt, args.user.id)
        .query(
          `INSERT INTO dbo.budget_allocations
             (household_id, year_month, category_id, amount, reason, transfer_group_id, note, created_by)
           VALUES (@hid, @ym, @cat, @amount, 'transfer', @group, @note, @by)`
        );
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback().catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------
// プールへ積む / プールから引き出す
// ---------------------------------------------------------------
const poolMoveSchema = z.object({
  amount: z.coerce.number().int().positive(),
  yearMonth: yearMonthSchema,
  /** 予算カテゴリとやり取りする場合に指定。省略すると「何もないところから」になる */
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  note: z.string().trim().max(200).optional(),
});

async function poolInHousehold(id: number, householdId: number): Promise<boolean> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('id', sql.BigInt, id)
    .input('hid', sql.BigInt, householdId)
    .query(`SELECT TOP 1 1 AS ok FROM dbo.pools WHERE id = @id AND household_id = @hid`);
  return r.recordset.length > 0;
}

/**
 * プールと予算の間でお金を動かす。
 * direction が 'in' なら プールへ入れる、'out' なら プールから出す。
 * categoryId があれば予算台帳と対で書き、無ければプール台帳だけに書く。
 */
async function movePool(args: {
  poolId: number;
  householdId: number;
  yearMonth: string;
  amount: number;
  direction: 'in' | 'out';
  categoryId: number | null;
  note: string | null;
  user: AuthedUser;
}): Promise<void> {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  const paired = args.categoryId !== null;
  const groupId = paired ? randomUUID() : null;

  const poolAmount = args.direction === 'in' ? args.amount : -args.amount;
  const poolReason = paired
    ? args.direction === 'in'
      ? 'from_budget'
      : 'to_budget'
    : args.direction === 'in'
    ? 'external_in'
    : 'external_out';

  try {
    await transaction.begin();

    let allocationId: number | null = null;

    if (paired) {
      // プールへ入れるなら予算はマイナス、出すなら予算はプラス
      const budgetAmount = args.direction === 'in' ? -args.amount : args.amount;
      const reason = args.direction === 'in' ? 'to_pool' : 'from_pool';

      const inserted = await new sql.Request(transaction)
        .input('hid', sql.BigInt, args.householdId)
        .input('ym', sql.Char(7), args.yearMonth)
        .input('cat', sql.BigInt, args.categoryId)
        .input('amount', sql.BigInt, budgetAmount)
        .input('reason', sql.NVarChar(20), reason)
        .input('group', sql.UniqueIdentifier, groupId)
        .input('note', sql.NVarChar(200), args.note)
        .input('by', sql.BigInt, args.user.id)
        .query(
          `INSERT INTO dbo.budget_allocations
             (household_id, year_month, category_id, amount, reason, transfer_group_id, note, created_by)
           OUTPUT INSERTED.id
           VALUES (@hid, @ym, @cat, @amount, @reason, @group, @note, @by)`
        );
      allocationId = num(inserted.recordset[0].id);
    }

    await new sql.Request(transaction)
      .input('hid', sql.BigInt, args.householdId)
      .input('pool', sql.BigInt, args.poolId)
      .input('ym', sql.Char(7), args.yearMonth)
      .input('date', sql.Date, `${args.yearMonth}-01`)
      .input('amount', sql.BigInt, poolAmount)
      .input('reason', sql.NVarChar(20), poolReason)
      .input('group', sql.UniqueIdentifier, groupId)
      .input('alloc', sql.BigInt, allocationId)
      .input('note', sql.NVarChar(200), args.note)
      .input('by', sql.BigInt, args.user.id)
      .query(
        `INSERT INTO dbo.pool_movements
           (household_id, pool_id, moved_on, year_month, amount, reason,
            transfer_group_id, budget_allocation_id, note, created_by)
         VALUES (@hid, @pool, @date, @ym, @amount, @reason, @group, @alloc, @note, @by)`
      );

    await transaction.commit();
  } catch (err) {
    await transaction.rollback().catch(() => undefined);
    throw err;
  }
}

app.http('poolContribute', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'pools/{id}/contribute',
  handler: withAuth(async (req, ctx, { user }) => {
    const poolId = Number(req.params.id);
    if (!Number.isInteger(poolId) || poolId <= 0) {
      return fail(400, 'VALIDATION_ERROR', 'プールIDが不正です');
    }

    const parsed = poolMoveSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;

    try {
      if (!(await poolInHousehold(poolId, user.householdId))) {
        return fail(404, 'NOT_FOUND', 'プールが見つかりません');
      }

      const closed = await assertPeriodOpen(user.householdId, input.yearMonth);
      if (closed) return fail(409, 'PERIOD_CLOSED', closed);

      if (input.categoryId) {
        if (!(await categoryInHousehold(input.categoryId, user.householdId))) {
          return fail(400, 'VALIDATION_ERROR', '指定されたカテゴリが見つかりません');
        }
        // 組み換えと同じく、残額不足でも止めない（マイナス配分を許容する）
      }

      await ensurePeriod(user.householdId, input.yearMonth);
      await movePool({
        poolId,
        householdId: user.householdId,
        yearMonth: input.yearMonth,
        amount: input.amount,
        direction: 'in',
        categoryId: input.categoryId ?? null,
        note: input.note ?? null,
        user,
      });

      return ok({ poolId, added: input.amount, fromCategoryId: input.categoryId ?? null });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('poolDraw', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'pools/{id}/draw',
  handler: withAuth(async (req, ctx, { user }) => {
    const poolId = Number(req.params.id);
    if (!Number.isInteger(poolId) || poolId <= 0) {
      return fail(400, 'VALIDATION_ERROR', 'プールIDが不正です');
    }

    const parsed = poolMoveSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;

    try {
      if (!(await poolInHousehold(poolId, user.householdId))) {
        return fail(404, 'NOT_FOUND', 'プールが見つかりません');
      }

      const closed = await assertPeriodOpen(user.householdId, input.yearMonth);
      if (closed) return fail(409, 'PERIOD_CLOSED', closed);

      const pool = await getPool();
      const balanceRow = await pool
        .request()
        .input('id', sql.BigInt, poolId)
        .query(`SELECT balance FROM dbo.vw_pool_balances WHERE pool_id = @id`);
      const balance = num(balanceRow.recordset[0]?.balance);

      if (balance < input.amount) {
        return fail(409, 'INSUFFICIENT_POOL', 'プールの残高が足りません', {
          balance,
          requested: input.amount,
        });
      }

      if (input.categoryId && !(await categoryInHousehold(input.categoryId, user.householdId))) {
        return fail(400, 'VALIDATION_ERROR', '指定されたカテゴリが見つかりません');
      }

      await ensurePeriod(user.householdId, input.yearMonth);
      await movePool({
        poolId,
        householdId: user.householdId,
        yearMonth: input.yearMonth,
        amount: input.amount,
        direction: 'out',
        categoryId: input.categoryId ?? null,
        note: input.note ?? null,
        user,
      });

      return ok({ poolId, drawn: input.amount, toCategoryId: input.categoryId ?? null });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 配分履歴
// ---------------------------------------------------------------
app.http('budgetsHistory', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'budgets/{ym}/history',
  handler: withAuth(async (req, ctx, { user }) => {
    const ym = req.params.ym;
    if (!monthRange(ym)) return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');

    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('ym', sql.Char(7), ym)
        .query(
          `SELECT ba.id, ba.amount, ba.reason, ba.transfer_group_id, ba.note, ba.created_at,
                  c.name AS category_name, u.display_name AS created_by_name
             FROM dbo.budget_allocations ba
             JOIN dbo.budget_categories c ON c.id = ba.category_id
             LEFT JOIN dbo.users u ON u.id = ba.created_by
            WHERE ba.household_id = @hid AND ba.year_month = @ym
            ORDER BY ba.created_at DESC, ba.id DESC`
        );

      return ok(
        result.recordset.map((row) => ({
          id: num(row.id),
          amount: num(row.amount),
          reason: row.reason,
          transferGroupId: row.transfer_group_id,
          categoryName: row.category_name,
          note: row.note,
          createdByName: row.created_by_name,
          createdAt: row.created_at,
        }))
      );
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
