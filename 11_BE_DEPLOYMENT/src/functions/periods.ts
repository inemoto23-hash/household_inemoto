/**
 * 月次締めと繰り越し。
 *
 * 締めると、その月の余り／不足がカテゴリごとのポリシーに従って翌月へ渡る。
 * 締めた月は配分を変えられなくなる（assertPeriodOpen が拒否する）。
 *
 * 必ず「プレビュー → 承認」の2段階にする。
 * 何がどう動くか見ないまま押せる操作にしてはいけない。
 */
import { app } from '@azure/functions';
import { randomUUID } from 'node:crypto';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import { monthRange } from '../domain/entry';

/** 'YYYY-MM' の翌月 */
function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' の前月 */
function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** その月の末日。プール移動の日付に使う */
function lastDay(ym: string): string {
  const range = monthRange(ym)!;
  const d = new Date(`${range.toExclusive}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

type Action = 'none' | 'carry' | 'to_pool';

interface Line {
  categoryId: number;
  name: string;
  color: string | null;
  icon: string | null;
  policy: string;
  allocated: number;
  spent: number;
  remaining: number;
  action: Action;
  /** 動く金額。action が none なら 0 */
  amount: number;
  poolId: number | null;
  poolName: string | null;
}

/**
 * 締めたときに何が起きるかを計算する。
 * 書き込みは一切しない。プレビューと実行で同じ関数を使い、表示と結果を必ず一致させる。
 */
async function computeLines(householdId: number, ym: string): Promise<Line[]> {
  const range = monthRange(ym)!;
  const pool = await getPool();

  const r = await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .input('ym', sql.Char(7), ym)
    .input('from', sql.Date, range.from)
    .input('to', sql.Date, range.toExclusive)
    .query(
      `SELECT c.id, c.name, c.color, c.icon, c.carry_over_policy, c.carry_over_pool_id,
              p.name AS pool_name,
              ISNULL(al.allocated, 0) AS allocated,
              ISNULL(sp.spent, 0)     AS spent
         FROM dbo.budget_categories c
         LEFT JOIN dbo.pools p ON p.id = c.carry_over_pool_id
         OUTER APPLY (SELECT SUM(amount) AS allocated FROM dbo.budget_allocations ba
                       WHERE ba.category_id = c.id AND ba.year_month = @ym) al
         OUTER APPLY (SELECT SUM(CASE WHEN e.kind = 'expense' THEN e.amount
                                      WHEN e.kind = 'refund'  THEN -e.amount
                                      ELSE 0 END) AS spent
                        FROM dbo.entries e
                       WHERE e.budget_category_id = c.id AND e.is_deleted = 0
                         AND e.entry_date >= @from AND e.entry_date < @to) sp
        WHERE c.household_id = @hid AND c.is_archived = 0 AND c.kind = N'expense'
        ORDER BY c.order_index, c.name`
    );

  return r.recordset.map((row) => {
    const allocated = num(row.allocated);
    const spent = num(row.spent);
    const remaining = allocated - spent;
    const policy = row.carry_over_policy as string;
    const poolId = numOrNull(row.carry_over_pool_id);

    let action: Action = 'none';
    let amount = 0;

    if (policy === 'surplus' && remaining > 0) {
      action = 'carry';
      amount = remaining;
    } else if (policy === 'full' && remaining !== 0) {
      // 使いすぎた分も翌月から差し引く。マイナスのまま渡す
      action = 'carry';
      amount = remaining;
    } else if (policy === 'to_pool' && remaining > 0 && poolId) {
      action = 'to_pool';
      amount = remaining;
    }

    return {
      categoryId: num(row.id),
      name: row.name,
      color: row.color,
      icon: row.icon,
      policy,
      allocated,
      spent,
      remaining,
      action,
      amount,
      poolId,
      poolName: row.pool_name,
    };
  });
}

async function periodStatus(householdId: number, ym: string): Promise<string | null> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .input('ym', sql.Char(7), ym)
    .query(`SELECT TOP 1 status FROM dbo.budget_periods WHERE household_id = @hid AND year_month = @ym`);
  return r.recordset[0]?.status ?? null;
}

// ---------------------------------------------------------------
// プレビュー
// ---------------------------------------------------------------
app.http('periodPreview', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'periods/{ym}/close-preview',
  handler: withAuth(async (req, ctx, { user }) => {
    const ym = req.params.ym;
    if (!monthRange(ym)) return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');

    try {
      const status = await periodStatus(user.householdId, ym);
      const lines = await computeLines(user.householdId, ym);

      // 前の月が開いたままなら、先にそちらを締める必要がある。
      // 古い月の繰越が後から降ってくると、締めた月の数字が動いてしまう
      const previous = prevMonth(ym);
      const prevStatus = await periodStatus(user.householdId, previous);
      const blockedBy = prevStatus === 'active' ? previous : null;

      return ok({
        yearMonth: ym,
        nextMonth: nextMonth(ym),
        status: status ?? 'active',
        blockedByPreviousMonth: blockedBy,
        lines,
        totals: {
          carry: lines.filter((l) => l.action === 'carry').reduce((s, l) => s + l.amount, 0),
          toPool: lines.filter((l) => l.action === 'to_pool').reduce((s, l) => s + l.amount, 0),
          surplus: lines.reduce((s, l) => s + Math.max(0, l.remaining), 0),
          shortage: lines.reduce((s, l) => s + Math.min(0, l.remaining), 0),
        },
      });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 締める
// ---------------------------------------------------------------
app.http('periodClose', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'periods/{ym}/close',
  handler: withAuth(async (req, ctx, { user }) => {
    const ym = req.params.ym;
    if (!monthRange(ym)) return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');

    const target = nextMonth(ym);

    try {
      if ((await periodStatus(user.householdId, ym)) === 'closed') {
        return fail(409, 'ALREADY_CLOSED', 'この月はすでに締め済みです');
      }
      const prevStatus = await periodStatus(user.householdId, prevMonth(ym));
      if (prevStatus === 'active') {
        return fail(409, 'PREVIOUS_MONTH_OPEN', `先に ${prevMonth(ym)} を締めてください`);
      }

      const lines = await computeLines(user.householdId, ym);
      const moving = lines.filter((l) => l.action !== 'none' && l.amount !== 0);

      const pool = await getPool();
      const transaction = new sql.Transaction(pool);
      await transaction.begin();

      try {
        // 翌月の期間が無ければ作る。繰越の行き先が必要
        await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('ym', sql.Char(7), target)
          .query(
            `IF NOT EXISTS (SELECT 1 FROM dbo.budget_periods WHERE household_id = @hid AND year_month = @ym)
               INSERT INTO dbo.budget_periods (household_id, year_month) VALUES (@hid, @ym)`
          );

        for (const line of moving) {
          if (line.action === 'carry') {
            // 翌月へ +remaining（full の場合はマイナスもありうる）
            await new sql.Request(transaction)
              .input('hid', sql.BigInt, user.householdId)
              .input('ym', sql.Char(7), target)
              .input('cat', sql.BigInt, line.categoryId)
              .input('amount', sql.BigInt, line.amount)
              .input('note', sql.NVarChar(200), `${ym} からの繰越`)
              .input('by', sql.BigInt, user.id)
              .query(
                `INSERT INTO dbo.budget_allocations
                   (household_id, year_month, category_id, amount, reason, note, created_by)
                 VALUES (@hid, @ym, @cat, @amount, 'carry_over', @note, @by)`
              );
          } else {
            // 予算からプールへ。台帳をまたぐので対で書き、同じ transfer_group_id で結ぶ
            const group = randomUUID();

            const alloc = await new sql.Request(transaction)
              .input('hid', sql.BigInt, user.householdId)
              .input('ym', sql.Char(7), ym)
              .input('cat', sql.BigInt, line.categoryId)
              .input('amount', sql.BigInt, -line.amount)
              .input('group', sql.UniqueIdentifier, group)
              .input('note', sql.NVarChar(200), `${ym} の余りを ${line.poolName} へ`)
              .input('by', sql.BigInt, user.id)
              .query(
                `INSERT INTO dbo.budget_allocations
                   (household_id, year_month, category_id, amount, reason, transfer_group_id, note, created_by)
                 OUTPUT INSERTED.id
                 VALUES (@hid, @ym, @cat, @amount, 'carry_to_pool', @group, @note, @by)`
              );

            await new sql.Request(transaction)
              .input('hid', sql.BigInt, user.householdId)
              .input('pool', sql.BigInt, line.poolId)
              .input('on', sql.Date, lastDay(ym))
              .input('ym', sql.Char(7), ym)
              .input('amount', sql.BigInt, line.amount)
              .input('group', sql.UniqueIdentifier, group)
              .input('alloc', sql.BigInt, num(alloc.recordset[0].id))
              .input('note', sql.NVarChar(200), `${ym} の ${line.name} の余り`)
              .input('by', sql.BigInt, user.id)
              .query(
                `INSERT INTO dbo.pool_movements
                   (household_id, pool_id, moved_on, year_month, amount, reason,
                    transfer_group_id, budget_allocation_id, note, created_by)
                 VALUES (@hid, @pool, @on, @ym, @amount, 'carry_to_pool',
                         @group, @alloc, @note, @by)`
              );
          }
        }

        await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('ym', sql.Char(7), ym)
          .input('by', sql.BigInt, user.id)
          .query(
            `IF EXISTS (SELECT 1 FROM dbo.budget_periods WHERE household_id = @hid AND year_month = @ym)
               UPDATE dbo.budget_periods
                  SET status = N'closed', closed_at = SYSUTCDATETIME(), closed_by = @by
                WHERE household_id = @hid AND year_month = @ym
             ELSE
               INSERT INTO dbo.budget_periods (household_id, year_month, status, closed_at, closed_by)
               VALUES (@hid, @ym, N'closed', SYSUTCDATETIME(), @by)`
          );

        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }

      return ok({ yearMonth: ym, nextMonth: target, moved: moving.length });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 締めを戻す
// ---------------------------------------------------------------
app.http('periodReopen', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'periods/{ym}/reopen',
  handler: withAuth(async (req, ctx, { user }) => {
    const ym = req.params.ym;
    if (!monthRange(ym)) return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');

    const target = nextMonth(ym);

    try {
      if ((await periodStatus(user.householdId, ym)) !== 'closed') {
        return fail(409, 'NOT_CLOSED', 'この月は締められていません');
      }
      // 翌月まで締まっていると、その繰越の上にさらに積み上がっている。
      // 順番に戻さないと数字が合わなくなるため、新しい月から戻してもらう
      if ((await periodStatus(user.householdId, target)) === 'closed') {
        return fail(409, 'NEXT_MONTH_CLOSED', `先に ${target} の締めを戻してください`);
      }

      const pool = await getPool();
      const transaction = new sql.Transaction(pool);
      await transaction.begin();

      try {
        // 締めが作った行を取り消す。
        //
        // 台帳は原則として追記専用だが、締めは「その時点の残額から機械的に導ける操作」であり、
        // 戻したあとに ±の対が履歴へ残ると、翌月の履歴が取り消しの記録だらけになって読めなくなる。
        // また ux_alloc_carryover（カテゴリごとに繰越は1行まで）は、
        // 取り消し時に行が消えることを前提にした制約になっている。
        await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('ym', sql.Char(7), target)
          .query(
            `DELETE FROM dbo.budget_allocations
              WHERE household_id = @hid AND year_month = @ym AND reason = 'carry_over'`
          );

        // プールへ移した分は対の両側をまとめて消す。
        // 利用者が手で拠出した to_pool と混ざらないよう、締めが作った行だけを
        // carry_to_pool という専用の理由で印を付けてある
        await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('ym', sql.Char(7), ym)
          .query(
            `DELETE FROM dbo.pool_movements
              WHERE household_id = @hid AND year_month = @ym AND reason = 'carry_to_pool'`
          );
        await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('ym', sql.Char(7), ym)
          .query(
            `DELETE FROM dbo.budget_allocations
              WHERE household_id = @hid AND year_month = @ym AND reason = 'carry_to_pool'`
          );

        await new sql.Request(transaction)
          .input('hid', sql.BigInt, user.householdId)
          .input('ym', sql.Char(7), ym)
          .query(
            `UPDATE dbo.budget_periods
                SET status = N'active', closed_at = NULL, closed_by = NULL
              WHERE household_id = @hid AND year_month = @ym`
          );

        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }

      return ok({ yearMonth: ym, status: 'active' });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
