/**
 * 定期取引の規則。
 *
 * 規則は「取引の雛形」＋「次にいつ記帳するか」を1行に持つ。
 * 未来の取引行は作らない。日次タイマー（recurringSweep）が、
 * その日が来たものだけを entries へ実体化する。
 *
 * 雛形の整合は domain/entry.ts の normalizeEntry が担保し、
 * 最終防衛線として DB の ck_rec_shape 制約が効く。取引と同じ守り方をする。
 */
import { app } from '@azure/functions';
import { z } from 'zod';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import { normalizeEntry, EntryInput } from '../domain/entry';
import {
  Recurrence,
  describeRecurrence,
  firstOccurrence,
  nextOccurrence,
  normalizeRecurrence,
  occurrenceOnOrAfter,
  recurrenceSchema,
  todayJst,
  validateRecurrence,
} from '../domain/recurrence';

/**
 * 規則を保存する直前に、次回予定日を今日以降へ寄せる。
 *
 * 過去の記録を定期にしたときや、過去の開始日で規則を作ったときに
 * next_date が過去日のまま保存されると、recurringSweep が 62日以内の分を
 * 実体化してしまう。**作った（直した）瞬間に古い明細が湧く**のは事故でしかない。
 *
 * 起点（start_date）は動かさない。「毎月20日」という規則は元の記録の日付から
 * 導けるほうが読みやすく、週次の間隔は開始週を基準に数えるため、
 * 起点を動かすと周期そのものがずれる。**動かすのは次回予定日だけ。**
 *
 * 追いつき（recurringSweep）はこれとは別物なので触らない。
 * あちらはタイマーが止まっていた規則を拾い直すためのもので、目的が違う。
 */
function notInThePast(recurrence: Recurrence, next: string | null): string | null {
  if (!next) return null;
  const today = todayJst();
  return next < today ? occurrenceOnOrAfter(recurrence, today) : next;
}

const SELECT_RULE = `
  SELECT r.id, r.kind, r.amount,
         r.budget_category_id, c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
         r.pool_id,            p.name AS pool_name,
         r.account_id,         a.name AS account_name,  a.color AS account_color,  a.icon AS account_icon,
         r.counter_account_id, ca.name AS counter_account_name,
         r.merchant, r.memo,
         r.freq, r.interval_n, r.day_of_month, r.month_of_year, r.weekday,
         r.start_date, r.end_date, r.next_date, r.last_posted_date,
         r.is_active, r.created_by, cu.display_name AS created_by_name
    FROM dbo.recurring_rules r
    LEFT JOIN dbo.budget_categories c ON c.id  = r.budget_category_id
    LEFT JOIN dbo.pools p             ON p.id  = r.pool_id
    LEFT JOIN dbo.accounts a          ON a.id  = r.account_id
    LEFT JOIN dbo.accounts ca         ON ca.id = r.counter_account_id
    LEFT JOIN dbo.users cu            ON cu.id = r.created_by
`;

const dateOnly = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
};

/** DB の1行を、規則として扱える形に読み替える */
function toRecurrence(row: Record<string, any>): Recurrence {
  return {
    freq: row.freq,
    intervalN: num(row.interval_n),
    dayOfMonth: row.day_of_month === null ? null : num(row.day_of_month),
    monthOfYear: row.month_of_year === null ? null : num(row.month_of_year),
    weekday: row.weekday === null ? null : num(row.weekday),
    startDate: dateOnly(row.start_date)!,
    endDate: dateOnly(row.end_date),
  };
}

function mapRule(row: Record<string, any>) {
  const recurrence = toRecurrence(row);
  return {
    id: num(row.id),
    kind: row.kind,
    amount: num(row.amount),
    budgetCategoryId: numOrNull(row.budget_category_id),
    categoryName: row.category_name,
    categoryColor: row.category_color,
    categoryIcon: row.category_icon,
    poolId: numOrNull(row.pool_id),
    poolName: row.pool_name,
    accountId: numOrNull(row.account_id),
    accountName: row.account_name,
    accountColor: row.account_color,
    accountIcon: row.account_icon,
    counterAccountId: numOrNull(row.counter_account_id),
    counterAccountName: row.counter_account_name,
    merchant: row.merchant,
    memo: row.memo,
    ...recurrence,
    nextDate: dateOnly(row.next_date),
    lastPostedDate: dateOnly(row.last_posted_date),
    isActive: !!row.is_active,
    description: describeRecurrence(recurrence),
    createdBy: numOrNull(row.created_by),
    createdByName: row.created_by_name,
  };
}

// ---------------------------------------------------------------
// 入力
// ---------------------------------------------------------------

/** 規則の入力。取引の雛形と繰り返し条件をまとめて受け取る */
const ruleInputSchema = z
  .object({
    kind: z.enum(['expense', 'income', 'transfer']),
    amount: z.coerce.number().int().positive('金額は1円以上で入力してください'),
    budgetCategoryId: z.coerce.number().int().positive().nullable().optional(),
    poolId: z.coerce.number().int().positive().nullable().optional(),
    accountId: z.coerce.number().int().positive().nullable().optional(),
    counterAccountId: z.coerce.number().int().positive().nullable().optional(),
    merchant: z.string().trim().max(120).nullable().optional(),
    memo: z.string().trim().max(500).nullable().optional(),
    /** 開始日の分は既に記録済み（カレンダーから作った場合）。その日は飛ばす */
    skipFirst: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .and(recurrenceSchema);

type RuleInput = z.infer<typeof ruleInputSchema>;

/**
 * 雛形を取引と同じ規則で整える。
 * 種別を変えたときに前の種別の値が残っていても、ここで確実に落ちる。
 */
function normalizeTemplate(input: RuleInput) {
  const asEntry: EntryInput = {
    entryDate: input.startDate,
    kind: input.kind,
    amount: input.amount,
    budgetCategoryId: input.budgetCategoryId ?? null,
    poolId: input.poolId ?? null,
    accountId: input.accountId ?? null,
    counterAccountId: input.counterAccountId ?? null,
    merchant: input.merchant ?? null,
    memo: input.memo ?? null,
  };
  return normalizeEntry(asEntry);
}

/** 参照先がすべて同じ世帯のものか確かめる */
async function assertOwned(
  ids: { categoryId: number | null; poolId: number | null; accountIds: number[] },
  householdId: number
): Promise<string | null> {
  const pool = await getPool();

  if (ids.categoryId) {
    const r = await pool
      .request()
      .input('hid', sql.BigInt, householdId)
      .input('cat', sql.BigInt, ids.categoryId)
      .query(`SELECT TOP 1 1 AS ok FROM dbo.budget_categories WHERE id = @cat AND household_id = @hid`);
    if (!r.recordset[0]) return '指定されたカテゴリが見つかりません';
  }

  if (ids.poolId) {
    const r = await pool
      .request()
      .input('hid', sql.BigInt, householdId)
      .input('pid', sql.BigInt, ids.poolId)
      .query(`SELECT TOP 1 1 AS ok FROM dbo.pools WHERE id = @pid AND household_id = @hid`);
    if (!r.recordset[0]) return '指定されたプールが見つかりません';
  }

  if (ids.accountIds.length > 0) {
    const r = await pool
      .request()
      .input('hid', sql.BigInt, householdId)
      .query(
        `SELECT COUNT(*) AS n FROM dbo.accounts
          WHERE household_id = @hid AND id IN (${ids.accountIds.join(',')})`
      );
    if (num(r.recordset[0].n) !== ids.accountIds.length) return '指定された財布が見つかりません';
  }

  return null;
}

// ---------------------------------------------------------------
// 記帳（規則から取引を1件つくる）
// ---------------------------------------------------------------

export interface PostableRule {
  id: number;
  householdId: number;
  kind: string;
  amount: number;
  budgetCategoryId: number | null;
  poolId: number | null;
  accountId: number;
  counterAccountId: number | null;
  merchant: string | null;
  memo: string | null;
  createdBy: number | null;
}

/**
 * 規則から取引を1件つくる。
 *
 * 同じ規則・同じ日付の取引は一意インデックス ux_entries_recurring が止める。
 * 重複は失敗ではなく「既に目的は達成されている」とみなす。
 * タイマーの重複起動と、手動の「今すぐ記帳」が重なっても壊れない。
 */
export async function postOccurrence(
  rule: PostableRule,
  date: string
): Promise<'posted' | 'duplicate'> {
  const pool = await getPool();
  try {
    await pool
      .request()
      .input('hid', sql.BigInt, rule.householdId)
      .input('date', sql.Date, date)
      .input('kind', sql.NVarChar(10), rule.kind)
      .input('amount', sql.BigInt, rule.amount)
      .input('cat', sql.BigInt, rule.budgetCategoryId)
      .input('pool', sql.BigInt, rule.poolId)
      .input('acc', sql.BigInt, rule.accountId)
      .input('counter', sql.BigInt, rule.counterAccountId)
      .input('merchant', sql.NVarChar(120), rule.merchant)
      .input('memo', sql.NVarChar(500), rule.memo)
      .input('by', sql.BigInt, rule.createdBy)
      .input('rid', sql.BigInt, rule.id)
      .query(
        `INSERT INTO dbo.entries
           (household_id, entry_date, kind, amount,
            budget_category_id, pool_id, account_id, counter_account_id,
            merchant, memo, source, created_by, recurring_rule_id)
         VALUES (@hid, @date, @kind, @amount,
                 @cat, @pool, @acc, @counter,
                 @merchant, @memo, N'recurring', @by, @rid)`
      );
    return 'posted';
  } catch (err) {
    const code = (err as { number?: number }).number;
    if (code === 2601 || code === 2627) return 'duplicate';
    throw err;
  }
}

/** 規則の行から、記帳に必要な形を取り出す */
function toPostable(row: Record<string, any>, householdId: number): PostableRule {
  return {
    id: num(row.id),
    householdId,
    kind: row.kind,
    amount: num(row.amount),
    budgetCategoryId: numOrNull(row.budget_category_id),
    poolId: numOrNull(row.pool_id),
    accountId: num(row.account_id),
    counterAccountId: numOrNull(row.counter_account_id),
    merchant: row.merchant,
    memo: row.memo,
    createdBy: numOrNull(row.created_by),
  };
}

// ---------------------------------------------------------------
// 一覧
// ---------------------------------------------------------------
app.http('recurringList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'recurring',
  handler: withAuth(async (_req, ctx, { user }) => {
    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `${SELECT_RULE}
            WHERE r.household_id = @hid AND r.is_deleted = 0
            -- 止めているものは後ろへ。次に来るものから見たい
            ORDER BY r.is_active DESC, r.next_date, r.id`
        );
      return ok(result.recordset.map(mapRule));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 追加
// ---------------------------------------------------------------
app.http('recurringCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'recurring',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = ruleInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;

    const recurrence = normalizeRecurrence(input);
    const recurrenceError = validateRecurrence(recurrence);
    if (recurrenceError) return fail(400, 'VALIDATION_ERROR', recurrenceError);

    const normalized = normalizeTemplate(input);
    if (!normalized.ok || !normalized.entry) {
      return fail(400, 'VALIDATION_ERROR', normalized.error ?? '入力内容を確認してください');
    }
    const tpl = normalized.entry;

    // 開始日の分が既に記録済みなら、その日は飛ばして次から。
    // 起点が過去でも、実際に記帳を始めるのは今日以降にする
    const next = notInThePast(
      recurrence,
      input.skipFirst
        ? nextOccurrence(recurrence, recurrence.startDate)
        : firstOccurrence(recurrence)
    );
    if (!next) {
      return fail(400, 'VALIDATION_ERROR', 'この設定では記帳される日がありません。終了日を確認してください');
    }

    try {
      const ownError = await assertOwned(
        {
          categoryId: tpl.budgetCategoryId,
          poolId: tpl.poolId,
          accountIds: [tpl.accountId, tpl.counterAccountId].filter((v): v is number => v !== null),
        },
        user.householdId
      );
      if (ownError) return fail(400, 'VALIDATION_ERROR', ownError);

      const pool = await getPool();
      const inserted = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('kind', sql.NVarChar(10), tpl.kind)
        .input('amount', sql.BigInt, tpl.amount)
        .input('cat', sql.BigInt, tpl.budgetCategoryId)
        .input('pool', sql.BigInt, tpl.poolId)
        .input('acc', sql.BigInt, tpl.accountId)
        .input('counter', sql.BigInt, tpl.counterAccountId)
        .input('merchant', sql.NVarChar(120), tpl.merchant)
        .input('memo', sql.NVarChar(500), tpl.memo)
        .input('freq', sql.NVarChar(10), recurrence.freq)
        .input('interval', sql.SmallInt, recurrence.intervalN)
        .input('dom', sql.TinyInt, recurrence.dayOfMonth)
        .input('moy', sql.TinyInt, recurrence.monthOfYear)
        .input('wd', sql.TinyInt, recurrence.weekday)
        .input('start', sql.Date, recurrence.startDate)
        .input('end', sql.Date, recurrence.endDate)
        .input('next', sql.Date, next)
        .input('last', sql.Date, input.skipFirst ? recurrence.startDate : null)
        .input('by', sql.BigInt, user.id)
        .query(
          `INSERT INTO dbo.recurring_rules
             (household_id, kind, amount, budget_category_id, pool_id,
              account_id, counter_account_id, merchant, memo,
              freq, interval_n, day_of_month, month_of_year, weekday,
              start_date, end_date, next_date, last_posted_date, created_by)
           OUTPUT INSERTED.id
           VALUES (@hid, @kind, @amount, @cat, @pool,
                   @acc, @counter, @merchant, @memo,
                   @freq, @interval, @dom, @moy, @wd,
                   @start, @end, @next, @last, @by)`
        );

      const created = await pool
        .request()
        .input('id', sql.BigInt, inserted.recordset[0].id)
        .query(`${SELECT_RULE} WHERE r.id = @id`);

      return ok(mapRule(created.recordset[0]), 201);
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 更新（一時停止・再開もここ）
// ---------------------------------------------------------------
app.http('recurringUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'recurring/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'IDが不正です');

    try {
      const pool = await getPool();
      const current = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(`${SELECT_RULE} WHERE r.id = @id AND r.household_id = @hid AND r.is_deleted = 0`);

      if (!current.recordset[0]) return fail(404, 'NOT_FOUND', '定期取引が見つかりません');
      const before = mapRule(current.recordset[0]);

      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください');

      // 現在値に差分を重ねてから正規化する。
      // 種別を変えた場合、前の種別の項目はここで確実に落ちる
      const merged = {
        kind: before.kind,
        amount: before.amount,
        budgetCategoryId: before.budgetCategoryId,
        poolId: before.poolId,
        accountId: before.accountId,
        counterAccountId: before.counterAccountId,
        merchant: before.merchant,
        memo: before.memo,
        freq: before.freq,
        intervalN: before.intervalN,
        dayOfMonth: before.dayOfMonth,
        monthOfYear: before.monthOfYear,
        weekday: before.weekday,
        startDate: before.startDate,
        endDate: before.endDate,
        isActive: before.isActive,
        ...body,
      };

      const parsed = ruleInputSchema.safeParse(merged);
      if (!parsed.success) {
        return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
      }
      const input = parsed.data;

      const recurrence = normalizeRecurrence(input);
      const recurrenceError = validateRecurrence(recurrence);
      if (recurrenceError) return fail(400, 'VALIDATION_ERROR', recurrenceError);

      const normalized = normalizeTemplate(input);
      if (!normalized.ok || !normalized.entry) {
        return fail(400, 'VALIDATION_ERROR', normalized.error ?? '入力内容を確認してください');
      }
      const tpl = normalized.entry;

      const ownError = await assertOwned(
        {
          categoryId: tpl.budgetCategoryId,
          poolId: tpl.poolId,
          accountIds: [tpl.accountId, tpl.counterAccountId].filter((v): v is number => v !== null),
        },
        user.householdId
      );
      if (ownError) return fail(400, 'VALIDATION_ERROR', ownError);

      // 繰り返しが変わったら次回を引き直す。
      // 既に記帳した日は動かせないので、その翌日以降で数える。
      // 作るときと同じく、過去へ遡らせない（片方だけ直すと経路で挙動が割れる）
      const floor = before.lastPostedDate ?? recurrence.startDate;
      const next = notInThePast(
        recurrence,
        before.lastPostedDate ? nextOccurrence(recurrence, floor) : firstOccurrence(recurrence)
      );

      await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('kind', sql.NVarChar(10), tpl.kind)
        .input('amount', sql.BigInt, tpl.amount)
        .input('cat', sql.BigInt, tpl.budgetCategoryId)
        .input('pool', sql.BigInt, tpl.poolId)
        .input('acc', sql.BigInt, tpl.accountId)
        .input('counter', sql.BigInt, tpl.counterAccountId)
        .input('merchant', sql.NVarChar(120), tpl.merchant)
        .input('memo', sql.NVarChar(500), tpl.memo)
        .input('freq', sql.NVarChar(10), recurrence.freq)
        .input('interval', sql.SmallInt, recurrence.intervalN)
        .input('dom', sql.TinyInt, recurrence.dayOfMonth)
        .input('moy', sql.TinyInt, recurrence.monthOfYear)
        .input('wd', sql.TinyInt, recurrence.weekday)
        .input('start', sql.Date, recurrence.startDate)
        .input('end', sql.Date, recurrence.endDate)
        .input('next', sql.Date, next)
        .input('active', sql.Bit, input.isActive === false ? 0 : 1)
        .query(
          `UPDATE dbo.recurring_rules
              SET kind = @kind, amount = @amount,
                  budget_category_id = @cat, pool_id = @pool,
                  account_id = @acc, counter_account_id = @counter,
                  merchant = @merchant, memo = @memo,
                  freq = @freq, interval_n = @interval,
                  day_of_month = @dom, month_of_year = @moy, weekday = @wd,
                  start_date = @start, end_date = @end, next_date = @next,
                  is_active = @active, updated_at = SYSUTCDATETIME()
            WHERE id = @id`
        );

      const updated = await pool
        .request()
        .input('id', sql.BigInt, id)
        .query(`${SELECT_RULE} WHERE r.id = @id`);

      return ok(mapRule(updated.recordset[0]));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 削除（論理削除）
//
// 過去に作られた取引はそのまま残す。消してしまうと、その月の集計が遡って変わる。
// ---------------------------------------------------------------
app.http('recurringDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'recurring/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'IDが不正です');

    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `UPDATE dbo.recurring_rules
              SET is_deleted = 1, is_active = 0, next_date = NULL,
                  updated_at = SYSUTCDATETIME()
            OUTPUT INSERTED.id
            WHERE id = @id AND household_id = @hid AND is_deleted = 0`
        );

      if (!result.recordset[0]) return fail(404, 'NOT_FOUND', '定期取引が見つかりません');
      return ok({ id, isDeleted: true });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 今すぐ記帳
//
// 今日の日付で1件つくる。次回予定日は動かさない。
// 「前倒しで1回分を入れる」ではなく「今日その支払いがあった」を意味する。
// ---------------------------------------------------------------
app.http('recurringRun', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'recurring/{id}/run',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'IDが不正です');

    try {
      const pool = await getPool();
      const current = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `SELECT id, kind, amount, budget_category_id, pool_id,
                  account_id, counter_account_id, merchant, memo, created_by
             FROM dbo.recurring_rules
            WHERE id = @id AND household_id = @hid AND is_deleted = 0`
        );

      if (!current.recordset[0]) return fail(404, 'NOT_FOUND', '定期取引が見つかりません');

      const today = todayJst();
      const rule = toPostable(current.recordset[0], user.householdId);
      const result = await postOccurrence(rule, today);

      if (result === 'duplicate') {
        return fail(409, 'ALREADY_POSTED', 'この定期取引は今日すでに記帳されています');
      }

      await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('today', sql.Date, today)
        .query(
          `UPDATE dbo.recurring_rules
              SET last_posted_date = @today, updated_at = SYSUTCDATETIME()
            WHERE id = @id`
        );

      return ok({ id, postedOn: today }, 201);
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
