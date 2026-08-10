/**
 * マスタ（口座・カテゴリ・プール）の登録・編集・並べ替え・アーカイブ。
 *
 * 参照は accounts.ts / bootstrap.ts が持つ。ここは書き込みのみを担当する。
 *
 * 削除は行わない。取引レコードが参照しているため物理削除できず、
 * 消せてしまうと過去の月の集計が変わってしまう。使わなくなったものはアーカイブする。
 */
import { app, HttpRequest, InvocationContext } from '@azure/functions';
import { z } from 'zod';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth, AuthedUser } from '../shared/auth';

/** SQL Server の一意制約違反 */
const UNIQUE_VIOLATION = [2627, 2601];

function isUniqueViolation(err: unknown): boolean {
  return UNIQUE_VIOLATION.includes((err as { number?: number })?.number ?? 0);
}

/** 追加時の並び順。末尾に置く */
async function nextOrderIndex(table: string, householdId: number): Promise<number> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .query(`SELECT ISNULL(MAX(order_index), -1) + 1 AS next FROM dbo.${table} WHERE household_id = @hid`);
  return num(r.recordset[0].next);
}

/** 指定 ID がすべて同じ世帯のものか */
async function allInHousehold(table: string, ids: number[], householdId: number): Promise<boolean> {
  if (ids.length === 0) return true;
  const pool = await getPool();
  // ids は Zod で正の整数に絞り込み済みのため IN 句へ直接埋めても安全
  const r = await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .query(`SELECT COUNT(*) AS n FROM dbo.${table} WHERE household_id = @hid AND id IN (${ids.join(',')})`);
  return num(r.recordset[0].n) === ids.length;
}

/**
 * 並べ替えの共通処理。
 * 送られた順に order_index を振り直す。差分計算より単純で、件数も高々数十件。
 */
function reorderHandler(table: string) {
  const schema = z.object({ ids: z.array(z.coerce.number().int().positive()).max(200) });

  return async (req: HttpRequest, ctx: InvocationContext, { user }: { user: AuthedUser }) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const ids = [...new Set(parsed.data.ids)];

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    try {
      if (!(await allInHousehold(table, ids, user.householdId))) {
        return fail(400, 'VALIDATION_ERROR', 'この世帯のものでない項目が含まれています');
      }

      await transaction.begin();
      for (let i = 0; i < ids.length; i++) {
        await new sql.Request(transaction)
          .input('id', sql.BigInt, ids[i])
          .input('idx', sql.Int, i)
          .query(`UPDATE dbo.${table} SET order_index = @idx WHERE id = @id`);
      }
      await transaction.commit();

      return ok({ ids });
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      return internalError(err, (m) => ctx.error(m));
    }
  };
}

// ===============================================================
// 口座
// ===============================================================

const ACCOUNT_KINDS = ['bank', 'cash', 'emoney', 'investment', 'credit'] as const;

const accountBase = {
  name: z.string().trim().min(1).max(60),
  kind: z.enum(ACCOUNT_KINDS),
  ownerUserId: z.coerce.number().int().positive().nullable().optional(),
  openingBalance: z.coerce.number().int().optional(),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  icon: z.string().trim().max(40).nullable().optional(),
  color: z.string().trim().max(20).nullable().optional(),
  closingDay: z.coerce.number().int().min(1).max(31).nullable().optional(),
  paymentDay: z.coerce.number().int().min(1).max(31).nullable().optional(),
  paymentAccountId: z.coerce.number().int().positive().nullable().optional(),
  isArchived: z.boolean().optional(),
};

const accountCreateSchema = z.object({
  ...accountBase,
  openingBalance: z.coerce.number().int().default(0),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const accountUpdateSchema = z.object(accountBase).partial();

/**
 * クレジット専用項目を種別に合わせて整える。
 * ck_accounts_credit_fields と同じ判断を、画面の作りに依存しない位置でも行う。
 */
function normalizeCreditFields<T extends Record<string, any>>(kind: string, input: T) {
  if (kind === 'credit') return input;
  return { ...input, closingDay: null, paymentDay: null, paymentAccountId: null };
}

/** 参照先（所有者・支払口座）が同じ世帯のものか確かめる */
async function validateAccountRefs(
  input: { ownerUserId?: number | null; paymentAccountId?: number | null },
  householdId: number,
  selfId?: number
): Promise<string | null> {
  const pool = await getPool();

  if (input.ownerUserId) {
    const r = await pool
      .request()
      .input('id', sql.BigInt, input.ownerUserId)
      .input('hid', sql.BigInt, householdId)
      .query(`SELECT TOP 1 1 AS ok FROM dbo.users WHERE id = @id AND household_id = @hid`);
    if (!r.recordset[0]) return '指定された持ち主が見つかりません';
  }

  if (input.paymentAccountId) {
    if (selfId && input.paymentAccountId === selfId) return '支払口座に自分自身は指定できません';
    const r = await pool
      .request()
      .input('id', sql.BigInt, input.paymentAccountId)
      .input('hid', sql.BigInt, householdId)
      .query(`SELECT TOP 1 kind FROM dbo.accounts WHERE id = @id AND household_id = @hid`);
    if (!r.recordset[0]) return '指定された支払口座が見つかりません';
    if (r.recordset[0].kind === 'credit') return '支払口座にクレジットは指定できません';
  }

  return null;
}

app.http('accountCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'accounts',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = accountCreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = normalizeCreditFields(parsed.data.kind, parsed.data);

    try {
      const refError = await validateAccountRefs(input, user.householdId);
      if (refError) return fail(400, 'VALIDATION_ERROR', refError);

      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('name', sql.NVarChar(60), input.name)
        .input('kind', sql.NVarChar(20), input.kind)
        .input('owner', sql.BigInt, input.ownerUserId ?? null)
        .input('open_bal', sql.BigInt, input.openingBalance)
        .input('open_date', sql.Date, input.openingDate)
        .input('icon', sql.NVarChar(40), input.icon ?? null)
        .input('color', sql.NVarChar(20), input.color ?? null)
        .input('closing', sql.TinyInt, input.closingDay ?? null)
        .input('payday', sql.TinyInt, input.paymentDay ?? null)
        .input('pay_acc', sql.BigInt, input.paymentAccountId ?? null)
        .input('idx', sql.Int, await nextOrderIndex('accounts', user.householdId))
        .query(
          `INSERT INTO dbo.accounts
             (household_id, name, kind, owner_user_id, opening_balance, opening_date,
              icon, color, closing_day, payment_day, payment_account_id, order_index)
           OUTPUT INSERTED.id
           VALUES (@hid, @name, @kind, @owner, @open_bal, @open_date,
                   @icon, @color, @closing, @payday, @pay_acc, @idx)`
        );

      return ok({ id: num(result.recordset[0].id) }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(409, 'DUPLICATE_NAME', 'その名前の口座はすでにあります');
      }
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('accountUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'accounts/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', '口座IDが不正です');

    const parsed = accountUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }

    try {
      const pool = await getPool();
      const current = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(`SELECT kind FROM dbo.accounts WHERE id = @id AND household_id = @hid`);
      if (!current.recordset[0]) return fail(404, 'NOT_FOUND', '口座が見つかりません');

      // 種別を変えないなら現在の種別で判断する
      const kind = parsed.data.kind ?? current.recordset[0].kind;
      const input = normalizeCreditFields(kind, parsed.data);

      const refError = await validateAccountRefs(input, user.householdId, id);
      if (refError) return fail(400, 'VALIDATION_ERROR', refError);

      // クレジット以外へ変えた場合は専用項目を明示的に消す。
      // 送られてこなかった項目は触らないが、種別が変わったときだけは別
      const clearCredit = kind !== 'credit';

      const request = pool.request().input('id', sql.BigInt, id).input('hid', sql.BigInt, user.householdId);
      const sets: string[] = [];
      const put = (key: string, column: string, type: any, value: any) => {
        if (value === undefined) return;
        request.input(key, type, value);
        sets.push(`${column} = @${key}`);
      };

      put('name', 'name', sql.NVarChar(60), parsed.data.name);
      put('kind', 'kind', sql.NVarChar(20), parsed.data.kind);
      put('owner', 'owner_user_id', sql.BigInt, parsed.data.ownerUserId);
      put('open_bal', 'opening_balance', sql.BigInt, parsed.data.openingBalance);
      put('open_date', 'opening_date', sql.Date, parsed.data.openingDate);
      put('icon', 'icon', sql.NVarChar(40), parsed.data.icon);
      put('color', 'color', sql.NVarChar(20), parsed.data.color);
      put('archived', 'is_archived', sql.Bit, parsed.data.isArchived);
      put('closing', 'closing_day', sql.TinyInt, clearCredit ? null : input.closingDay);
      put('payday', 'payment_day', sql.TinyInt, clearCredit ? null : input.paymentDay);
      put('pay_acc', 'payment_account_id', sql.BigInt, clearCredit ? null : input.paymentAccountId);

      if (sets.length === 0) return ok({ id, changed: false });

      await request.query(`UPDATE dbo.accounts SET ${sets.join(', ')} WHERE id = @id AND household_id = @hid`);
      return ok({ id, changed: true });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(409, 'DUPLICATE_NAME', 'その名前の口座はすでにあります');
      }
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('accountReorder', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'accounts/order',
  handler: withAuth(reorderHandler('accounts')),
});

// ===============================================================
// 予算カテゴリ
// ===============================================================

const CARRY_POLICIES = ['none', 'surplus', 'full', 'to_pool'] as const;

const categoryBase = {
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['expense', 'income']),
  carryOverPolicy: z.enum(CARRY_POLICIES).optional(),
  carryOverPoolId: z.coerce.number().int().positive().nullable().optional(),
  icon: z.string().trim().max(40).nullable().optional(),
  color: z.string().trim().max(20).nullable().optional(),
  isArchived: z.boolean().optional(),
};

const categoryCreateSchema = z.object({
  ...categoryBase,
  carryOverPolicy: z.enum(CARRY_POLICIES).default('none'),
});

const categoryUpdateSchema = z.object(categoryBase).partial();

/** ck_bcat_pool_required と同じ判断。集約先は to_pool のときだけ持つ */
function normalizeCarryOver<T extends Record<string, any>>(policy: string, input: T) {
  if (policy === 'to_pool') return input;
  return { ...input, carryOverPoolId: null };
}

async function poolInHousehold(id: number, householdId: number): Promise<boolean> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('id', sql.BigInt, id)
    .input('hid', sql.BigInt, householdId)
    .query(`SELECT TOP 1 1 AS ok FROM dbo.pools WHERE id = @id AND household_id = @hid`);
  return r.recordset.length > 0;
}

app.http('categoryCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'categories',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = categoryCreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = normalizeCarryOver(parsed.data.carryOverPolicy, parsed.data);

    if (parsed.data.carryOverPolicy === 'to_pool' && !input.carryOverPoolId) {
      return fail(400, 'VALIDATION_ERROR', '繰越先のプールを選んでください');
    }

    try {
      if (input.carryOverPoolId && !(await poolInHousehold(input.carryOverPoolId, user.householdId))) {
        return fail(400, 'VALIDATION_ERROR', '指定されたプールが見つかりません');
      }

      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('name', sql.NVarChar(60), input.name)
        .input('kind', sql.NVarChar(10), input.kind)
        .input('carry', sql.NVarChar(20), input.carryOverPolicy)
        .input('carry_pool', sql.BigInt, input.carryOverPoolId ?? null)
        .input('icon', sql.NVarChar(40), input.icon ?? null)
        .input('color', sql.NVarChar(20), input.color ?? null)
        .input('idx', sql.Int, await nextOrderIndex('budget_categories', user.householdId))
        .query(
          `INSERT INTO dbo.budget_categories
             (household_id, name, kind, carry_over_policy, carry_over_pool_id, icon, color, order_index)
           OUTPUT INSERTED.id
           VALUES (@hid, @name, @kind, @carry, @carry_pool, @icon, @color, @idx)`
        );

      return ok({ id: num(result.recordset[0].id) }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(409, 'DUPLICATE_NAME', 'その名前のカテゴリはすでにあります');
      }
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('categoryUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'categories/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'カテゴリIDが不正です');

    const parsed = categoryUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }

    try {
      const pool = await getPool();
      const current = await pool
        .request()
        .input('id', sql.BigInt, id)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `SELECT carry_over_policy FROM dbo.budget_categories WHERE id = @id AND household_id = @hid`
        );
      if (!current.recordset[0]) return fail(404, 'NOT_FOUND', 'カテゴリが見つかりません');

      const policy = parsed.data.carryOverPolicy ?? current.recordset[0].carry_over_policy;
      const input = normalizeCarryOver(policy, parsed.data);
      const clearPool = policy !== 'to_pool';

      if (policy === 'to_pool' && parsed.data.carryOverPolicy && !input.carryOverPoolId) {
        return fail(400, 'VALIDATION_ERROR', '繰越先のプールを選んでください');
      }
      if (input.carryOverPoolId && !(await poolInHousehold(input.carryOverPoolId, user.householdId))) {
        return fail(400, 'VALIDATION_ERROR', '指定されたプールが見つかりません');
      }

      const request = pool.request().input('id', sql.BigInt, id).input('hid', sql.BigInt, user.householdId);
      const sets: string[] = [];
      const put = (key: string, column: string, type: any, value: any) => {
        if (value === undefined) return;
        request.input(key, type, value);
        sets.push(`${column} = @${key}`);
      };

      put('name', 'name', sql.NVarChar(60), parsed.data.name);
      put('kind', 'kind', sql.NVarChar(10), parsed.data.kind);
      put('carry', 'carry_over_policy', sql.NVarChar(20), parsed.data.carryOverPolicy);
      put('carry_pool', 'carry_over_pool_id', sql.BigInt, clearPool ? null : input.carryOverPoolId);
      put('icon', 'icon', sql.NVarChar(40), parsed.data.icon);
      put('color', 'color', sql.NVarChar(20), parsed.data.color);
      put('archived', 'is_archived', sql.Bit, parsed.data.isArchived);

      if (sets.length === 0) return ok({ id, changed: false });

      await request.query(
        `UPDATE dbo.budget_categories SET ${sets.join(', ')} WHERE id = @id AND household_id = @hid`
      );
      return ok({ id, changed: true });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(409, 'DUPLICATE_NAME', 'その名前のカテゴリはすでにあります');
      }
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('categoryReorder', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'categories/order',
  handler: withAuth(reorderHandler('budget_categories')),
});

// ===============================================================
// プール
// ===============================================================

const poolBase = {
  name: z.string().trim().min(1).max(60),
  purpose: z.string().trim().max(200).nullable().optional(),
  targetAmount: z.coerce.number().int().min(0).nullable().optional(),
  icon: z.string().trim().max(40).nullable().optional(),
  color: z.string().trim().max(20).nullable().optional(),
  isArchived: z.boolean().optional(),
};

const poolCreateSchema = z.object(poolBase);
const poolUpdateSchema = z.object(poolBase).partial();

app.http('poolsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'pools',
  handler: withAuth(async (req, ctx, { user }) => {
    const includeArchived = req.query.get('includeArchived') === 'true';
    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `SELECT p.id, p.name, p.purpose, p.target_amount, p.icon, p.color,
                  p.order_index, p.is_archived, b.balance
             FROM dbo.pools p
             LEFT JOIN dbo.vw_pool_balances b ON b.pool_id = p.id
            WHERE p.household_id = @hid
              ${includeArchived ? '' : 'AND p.is_archived = 0'}
            ORDER BY p.order_index, p.name`
        );

      return ok(
        result.recordset.map((row) => ({
          id: num(row.id),
          name: row.name,
          purpose: row.purpose,
          targetAmount: numOrNull(row.target_amount),
          icon: row.icon,
          color: row.color,
          orderIndex: num(row.order_index),
          isArchived: row.is_archived,
          balance: num(row.balance),
        }))
      );
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('poolCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'pools',
  handler: withAuth(async (req, ctx, { user }) => {
    const parsed = poolCreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;

    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('name', sql.NVarChar(60), input.name)
        .input('purpose', sql.NVarChar(200), input.purpose ?? null)
        .input('target', sql.BigInt, input.targetAmount ?? null)
        .input('icon', sql.NVarChar(40), input.icon ?? null)
        .input('color', sql.NVarChar(20), input.color ?? null)
        .input('idx', sql.Int, await nextOrderIndex('pools', user.householdId))
        .query(
          `INSERT INTO dbo.pools (household_id, name, purpose, target_amount, icon, color, order_index)
           OUTPUT INSERTED.id
           VALUES (@hid, @name, @purpose, @target, @icon, @color, @idx)`
        );

      return ok({ id: num(result.recordset[0].id) }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(409, 'DUPLICATE_NAME', 'その名前のプールはすでにあります');
      }
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('poolUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'pools/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(400, 'VALIDATION_ERROR', 'プールIDが不正です');

    const parsed = poolUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }

    try {
      if (!(await poolInHousehold(id, user.householdId))) {
        return fail(404, 'NOT_FOUND', 'プールが見つかりません');
      }

      const pool = await getPool();
      const request = pool.request().input('id', sql.BigInt, id).input('hid', sql.BigInt, user.householdId);
      const sets: string[] = [];
      const put = (key: string, column: string, type: any, value: any) => {
        if (value === undefined) return;
        request.input(key, type, value);
        sets.push(`${column} = @${key}`);
      };

      put('name', 'name', sql.NVarChar(60), parsed.data.name);
      put('purpose', 'purpose', sql.NVarChar(200), parsed.data.purpose);
      put('target', 'target_amount', sql.BigInt, parsed.data.targetAmount);
      put('icon', 'icon', sql.NVarChar(40), parsed.data.icon);
      put('color', 'color', sql.NVarChar(20), parsed.data.color);
      put('archived', 'is_archived', sql.Bit, parsed.data.isArchived);

      if (sets.length === 0) return ok({ id, changed: false });

      await request.query(`UPDATE dbo.pools SET ${sets.join(', ')} WHERE id = @id AND household_id = @hid`);
      return ok({ id, changed: true });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(409, 'DUPLICATE_NAME', 'その名前のプールはすでにあります');
      }
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('poolReorder', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'pools/order',
  handler: withAuth(reorderHandler('pools')),
});
