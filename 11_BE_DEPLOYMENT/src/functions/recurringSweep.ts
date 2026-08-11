/**
 * 定期取引の自動記帳。1日1回、その日までに来た予約を取引にする。
 *
 * 遅れて記帳するのは許すが、二重に記帳するのは許さない。
 * 二重の防止は DB の一意インデックス ux_entries_recurring に任せる。
 * アプリ側のチェックだけに頼ると、タイマーの重複起動で崩れる。
 *
 * 長く止めていた規則を再開したときに過去の記録が大量に湧かないよう、
 * 古すぎる予約は記帳せず読み飛ばす。
 */
import { app, InvocationContext, Timer } from '@azure/functions';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { occurrencesUpTo, todayJst, Recurrence } from '../domain/recurrence';
import { postOccurrence, PostableRule } from './recurring';

/** 1回の実行で処理する規則の上限。詰まっても翌日の実行で続きを拾う */
const RULE_LIMIT = 200;
/** 1つの規則で追いつく上限 */
const CATCH_UP_LIMIT = 12;
/** これより古い予約は記帳しない */
const SKIP_OLDER_THAN_DAYS = 62;

function dateOnly(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

interface DueRule extends PostableRule {
  recurrence: Recurrence;
  nextDate: string;
}

/** 今日までに来ている規則を引く */
async function findDue(today: string): Promise<DueRule[]> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('limit', sql.Int, RULE_LIMIT)
    .input('today', sql.Date, today)
    .query(`
      SELECT TOP (@limit)
             id, household_id, kind, amount, budget_category_id, pool_id,
             account_id, counter_account_id, merchant, memo, created_by,
             freq, interval_n, day_of_month, month_of_year, weekday,
             start_date, end_date, next_date
        FROM dbo.recurring_rules
       WHERE is_active = 1
         AND is_deleted = 0
         AND next_date IS NOT NULL
         AND next_date <= @today
       ORDER BY next_date
    `);

  return r.recordset.map((row) => ({
    id: num(row.id),
    householdId: num(row.household_id),
    kind: row.kind,
    amount: num(row.amount),
    budgetCategoryId: numOrNull(row.budget_category_id),
    poolId: numOrNull(row.pool_id),
    accountId: num(row.account_id),
    counterAccountId: numOrNull(row.counter_account_id),
    merchant: row.merchant,
    memo: row.memo,
    createdBy: numOrNull(row.created_by),
    nextDate: dateOnly(row.next_date)!,
    recurrence: {
      freq: row.freq,
      intervalN: num(row.interval_n),
      dayOfMonth: row.day_of_month === null ? null : num(row.day_of_month),
      monthOfYear: row.month_of_year === null ? null : num(row.month_of_year),
      weekday: row.weekday === null ? null : num(row.weekday),
      startDate: dateOnly(row.start_date)!,
      endDate: dateOnly(row.end_date),
    },
  }));
}

/** 進捗を進める。next が null なら、その規則は役目を終えている */
async function advance(id: number, next: string | null, lastPosted: string | null): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('id', sql.BigInt, id)
    .input('next', sql.Date, next)
    .input('last', sql.Date, lastPosted)
    .query(
      `UPDATE dbo.recurring_rules
          SET next_date = @next,
              last_posted_date = COALESCE(@last, last_posted_date),
              updated_at = SYSUTCDATETIME()
        WHERE id = @id`
    );
}

app.timer('recurringSweep', {
  // UTC 15:10 ＝ 日本時間 00:10。日付が変わってすぐ記帳する
  schedule: '0 10 15 * * *',
  handler: async (_timer: Timer, ctx: InvocationContext) => {
    const today = todayJst();
    const skipBefore = addDays(today, -SKIP_OLDER_THAN_DAYS);

    let due: DueRule[];
    try {
      due = await findDue(today);
    } catch (err) {
      ctx.error(`定期取引の取り出しに失敗: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (due.length === 0) return;
    ctx.log(`定期取引 ${due.length} 件を確認します（基準日 ${today}）`);

    for (const rule of due) {
      try {
        const plan = occurrencesUpTo(rule.recurrence, rule.nextDate, today, {
          limit: CATCH_UP_LIMIT,
          skipBefore,
        });

        let lastPosted: string | null = null;
        for (const date of plan.post) {
          const result = await postOccurrence(rule, date);
          lastPosted = date;
          if (result === 'duplicate') {
            ctx.log(`定期取引 ${rule.id}: ${date} は既に記帳済み`);
          }
        }

        if (plan.skipped > 0) {
          ctx.warn(`定期取引 ${rule.id}: ${SKIP_OLDER_THAN_DAYS}日より古い ${plan.skipped} 件を飛ばしました`);
        }

        await advance(rule.id, plan.next, lastPosted);
        if (plan.post.length > 0) {
          ctx.log(`定期取引 ${rule.id}: ${plan.post.length} 件を記帳、次回は ${plan.next ?? 'なし'}`);
        }
      } catch (err) {
        // 1つの規則の失敗で他を止めない。翌日の実行でもう一度拾われる
        ctx.error(
          `定期取引 ${rule.id} の記帳に失敗: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  },
});
