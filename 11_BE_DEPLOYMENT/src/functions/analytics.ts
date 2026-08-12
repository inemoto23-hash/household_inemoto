/**
 * 分析。
 *
 * Basic 5DTU では同時に走らせられる問い合わせが限られるため、
 * 画面1枚分をまとめて1往復で返す。
 *
 * 返金は支出を戻すもの。収入には混ぜず、支出から差し引く。
 * この扱いはカレンダーや予算画面と揃える。
 */
import { app } from '@azure/functions';
import { getPool, sql } from '../db/pool';
import { num } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';
import { monthRange } from '../domain/entry';
import { PLACE_LIMIT, placesSelect, toPlace } from '../shared/places';

/** 推移を何ヶ月分見せるか */
const TREND_MONTHS = 12;

/** 'YYYY-MM' に月を足す */
function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** 支出の符号を揃える式。返金は支出を戻す */
const SPEND = `CASE e.kind WHEN 'expense' THEN e.amount WHEN 'refund' THEN -e.amount ELSE 0 END`;
const INCOME = `CASE WHEN e.kind = 'income' THEN e.amount ELSE 0 END`;

app.http('analyticsMonth', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'analytics/{ym}',
  handler: withAuth(async (req, ctx, { user }) => {
    const ym = req.params.ym;
    const range = monthRange(ym);
    if (!range) return fail(400, 'VALIDATION_ERROR', '年月は YYYY-MM 形式で指定してください');

    const previous = monthRange(addMonths(ym, -1))!;
    const trendFrom = monthRange(addMonths(ym, -(TREND_MONTHS - 1)))!.from;

    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('from', sql.Date, range.from)
        .input('to', sql.Date, range.toExclusive)
        .input('pfrom', sql.Date, previous.from)
        .input('pto', sql.Date, previous.toExclusive)
        .input('tfrom', sql.Date, trendFrom)
        .input('places', sql.Int, PLACE_LIMIT)
        .query(`
          -- 1) 月次の推移
          SELECT CONVERT(CHAR(7), e.entry_date, 126) AS ym,
                 SUM(${SPEND})  AS expense,
                 SUM(${INCOME}) AS income
            FROM dbo.entries e
           WHERE e.household_id = @hid AND e.is_deleted = 0
             AND e.entry_date >= @tfrom AND e.entry_date < @to
           GROUP BY CONVERT(CHAR(7), e.entry_date, 126)
           ORDER BY 1;

          -- 2) カテゴリ別。前月と並べて増減が見えるようにする
          SELECT c.id, c.name, c.color, c.icon, c.kind,
                 SUM(CASE WHEN e.entry_date >= @from AND e.entry_date < @to
                          THEN (CASE WHEN c.kind = 'income' THEN ${INCOME} ELSE ${SPEND} END)
                          ELSE 0 END) AS current_amount,
                 SUM(CASE WHEN e.entry_date >= @pfrom AND e.entry_date < @pto
                          THEN (CASE WHEN c.kind = 'income' THEN ${INCOME} ELSE ${SPEND} END)
                          ELSE 0 END) AS previous_amount
            FROM dbo.entries e
            JOIN dbo.budget_categories c ON c.id = e.budget_category_id
           WHERE e.household_id = @hid AND e.is_deleted = 0
             AND e.entry_date >= @pfrom AND e.entry_date < @to
           GROUP BY c.id, c.name, c.color, c.icon, c.kind
           ORDER BY 6 DESC;

          -- 3) 支払い方法別
          SELECT a.id, a.name, a.kind, a.color, SUM(${SPEND}) AS amount
            FROM dbo.entries e
            JOIN dbo.accounts a ON a.id = e.account_id
           WHERE e.household_id = @hid AND e.is_deleted = 0
             AND e.entry_date >= @from AND e.entry_date < @to
             AND e.kind IN ('expense', 'refund')
           GROUP BY a.id, a.name, a.kind, a.color
          HAVING SUM(${SPEND}) <> 0
           ORDER BY 5 DESC;

          -- 4) 記録した人ごと
          SELECT u.id, u.display_name, u.color, u.icon,
                 SUM(${SPEND}) AS amount, COUNT(*) AS entry_count
            FROM dbo.entries e
            JOIN dbo.users u ON u.id = e.created_by
           WHERE e.household_id = @hid AND e.is_deleted = 0
             AND e.entry_date >= @from AND e.entry_date < @to
             AND e.kind IN ('expense', 'refund')
           GROUP BY u.id, u.display_name, u.color, u.icon
           ORDER BY 5 DESC;

          -- 5) 曜日別。DATEFIRST に左右されないよう日曜起点で数える
          --    1900-01-07 は日曜日
          SELECT DATEDIFF(day, '19000107', e.entry_date) % 7 AS weekday,
                 SUM(${SPEND}) AS amount, COUNT(*) AS entry_count
            FROM dbo.entries e
           WHERE e.household_id = @hid AND e.is_deleted = 0
             AND e.entry_date >= @from AND e.entry_date < @to
             AND e.kind IN ('expense', 'refund')
           GROUP BY DATEDIFF(day, '19000107', e.entry_date) % 7
           ORDER BY 1;

          -- 6) 場所別。座標があれば地図で開けるよう代表点も返す。
          --    支出マップと同じものを使う（shared/places.ts）。
          --    ここに書き直すと番号がずれる
          ${placesSelect()};
        `);

      const [trendRows, categoryRows, accountRows, memberRows, weekdayRows, placeRows] =
        result.recordsets as any[];

      // 記録の無い月も並べる。歯抜けだと推移が読めない
      const trendByMonth = new Map<string, { expense: number; income: number }>();
      for (const row of trendRows) {
        trendByMonth.set(row.ym, { expense: num(row.expense), income: num(row.income) });
      }
      const trend = Array.from({ length: TREND_MONTHS }, (_, i) => {
        const key = addMonths(ym, -(TREND_MONTHS - 1 - i));
        const value = trendByMonth.get(key);
        return { yearMonth: key, expense: value?.expense ?? 0, income: value?.income ?? 0 };
      });

      const categories = categoryRows.map((row: any) => ({
        id: num(row.id),
        name: row.name,
        color: row.color,
        icon: row.icon,
        kind: row.kind,
        amount: num(row.current_amount),
        previousAmount: num(row.previous_amount),
      }));

      const expenseCategories = categories.filter((c: any) => c.kind === 'expense' && c.amount !== 0);
      const incomeCategories = categories.filter((c: any) => c.kind === 'income' && c.amount !== 0);

      const current = trend[trend.length - 1];

      return ok({
        yearMonth: ym,
        total: {
          expense: current.expense,
          income: current.income,
          net: current.income - current.expense,
          // 前月と比べてどうか
          previousExpense: trend[trend.length - 2]?.expense ?? 0,
        },
        trend,
        expenseCategories,
        incomeCategories,
        accounts: accountRows.map((row: any) => ({
          id: num(row.id),
          name: row.name,
          kind: row.kind,
          color: row.color,
          amount: num(row.amount),
        })),
        members: memberRows.map((row: any) => ({
          id: num(row.id),
          displayName: row.display_name,
          color: row.color,
          icon: row.icon,
          amount: num(row.amount),
          entryCount: num(row.entry_count),
        })),
        weekdays: weekdayRows.map((row: any) => ({
          weekday: num(row.weekday),
          amount: num(row.amount),
          entryCount: num(row.entry_count),
        })),
        places: placeRows.map(toPlace),
      });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
