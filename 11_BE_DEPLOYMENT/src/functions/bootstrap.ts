/**
 * 初回一括取得とカテゴリ参照。
 *
 * Basic 5DTU は同時ワーカー数が限られるため、画面起動時に何度も往復させない。
 * 世帯・利用者・口座・カテゴリ・プールを1回で返す。
 */
import { app } from '@azure/functions';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { ok, internalError } from '../shared/http';
import { withAuth } from '../shared/auth';

function mapCategory(row: Record<string, any>) {
  // 今月の配分と消化。選択欄に残りを出すために使う（categories 単体取得では入らない）
  const allocated = row.allocated === undefined ? null : num(row.allocated);
  const spent = row.spent === undefined ? null : num(row.spent);

  return {
    allocated,
    spent,
    remaining: allocated === null || spent === null ? null : allocated - spent,
    id: num(row.id),
    name: row.name,
    kind: row.kind,
    carryOverPolicy: row.carry_over_policy,
    carryOverPoolId: numOrNull(row.carry_over_pool_id),
    /** 新しい月を開いたときに配分として入る額 */
    defaultAmount: num(row.default_amount),
    parentId: numOrNull(row.parent_id),
    icon: row.icon,
    color: row.color,
    orderIndex: num(row.order_index),
    isArchived: row.is_archived,
  };
}

app.http('categoriesList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'categories',
  handler: withAuth(async (req, ctx, { user }) => {
    const includeArchived = req.query.get('includeArchived') === 'true';
    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `SELECT id, name, kind, carry_over_policy, carry_over_pool_id, parent_id,
                  icon, color, order_index, is_archived, default_amount
             FROM dbo.budget_categories
            WHERE household_id = @hid
              ${includeArchived ? '' : 'AND is_archived = 0'}
            ORDER BY kind DESC, order_index, name`
        );
      return ok(result.recordset.map(mapCategory));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

app.http('bootstrap', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'bootstrap',
  handler: withAuth(async (_req, ctx, { user }) => {
    try {
      const pool = await getPool();

      // 1往復にまとめる。件数はいずれも数十件なので分割する意味がない
      //
      // 「今月」は日本時間で判定する。サーバーは UTC で動くため、
      // 夜間に月をまたぐと1日ずれた月を今月として扱ってしまう
      const result = await pool.request().input('hid', sql.BigInt, user.householdId).query(`
        DECLARE @today DATE = CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC'
                                   AT TIME ZONE 'Tokyo Standard Time' AS DATE);
        DECLARE @ym CHAR(7) = CONVERT(CHAR(7), @today, 126);
        DECLARE @from DATE = DATEFROMPARTS(YEAR(@today), MONTH(@today), 1);
        DECLARE @to   DATE = DATEADD(month, 1, @from);

        SELECT id, name, home_lat, home_lng, home_radius_m
          FROM dbo.households WHERE id = @hid;

        SELECT id, display_name, email, role, color, icon,
               CAST(CASE WHEN avatar_data IS NULL THEN 0 ELSE 1 END AS BIT) AS has_avatar,
               avatar_updated_at, is_active
          FROM dbo.users
         WHERE household_id = @hid AND is_active = 1
         ORDER BY id;

        SELECT a.id, a.name, a.kind, a.owner_user_id, a.order_index, a.icon, a.color,
               a.is_charge_source,
               b.balance
          FROM dbo.accounts a
          LEFT JOIN dbo.vw_account_balances b ON b.account_id = a.id
         WHERE a.household_id = @hid AND a.is_archived = 0
         ORDER BY a.order_index, a.name;

        SELECT c.id, c.name, c.kind, c.carry_over_policy, c.carry_over_pool_id, c.parent_id,
               c.icon, c.color, c.order_index, c.is_archived, c.default_amount,
               ISNULL(al.allocated, 0) AS allocated,
               ISNULL(sp.spent, 0)     AS spent
          FROM dbo.budget_categories c
          OUTER APPLY (SELECT SUM(amount) AS allocated FROM dbo.budget_allocations ba
                        WHERE ba.category_id = c.id AND ba.year_month = @ym) al
          OUTER APPLY (SELECT SUM(CASE WHEN e.kind = 'expense' THEN e.amount
                                       WHEN e.kind = 'refund'  THEN -e.amount
                                       WHEN e.kind = 'income'  THEN e.amount
                                       ELSE 0 END) AS spent
                         FROM dbo.entries e
                        WHERE e.budget_category_id = c.id AND e.is_deleted = 0
                          AND e.entry_date >= @from AND e.entry_date < @to) sp
         WHERE c.household_id = @hid AND c.is_archived = 0
         ORDER BY c.kind DESC, c.order_index, c.name;

        SELECT p.id, p.name, p.purpose, p.target_amount, p.icon, p.color, p.order_index,
               b.balance
          FROM dbo.pools p
          LEFT JOIN dbo.vw_pool_balances b ON b.pool_id = p.id
         WHERE p.household_id = @hid AND p.is_archived = 0
         ORDER BY p.order_index, p.name;

        SELECT account_id FROM dbo.user_account_priorities WHERE user_id = ${user.id};

        SELECT COUNT(*) AS pending FROM dbo.entry_stock
         WHERE household_id = @hid AND status = N'pending';
      `);

      const [households, users, accounts, categories, pools, priorities, stock] =
        result.recordsets as any[];
      const priorityIds = new Set(priorities.map((r: any) => num(r.account_id)));

      return ok({
        household: households[0] ? { id: num(households[0].id), name: households[0].name } : null,
        /**
         * 自宅の位置。画面はこれを見て、自宅で記録しているかを判定する。
         * 判定そのものは BE でも行うので、これは表示のためだけ。
         */
        home:
          households[0] && households[0].home_lat !== null && households[0].home_lng !== null
            ? {
                lat: Number(households[0].home_lat),
                lng: Number(households[0].home_lng),
                radiusM: Number(households[0].home_radius_m),
              }
            : null,
        me: { id: user.id, displayName: user.displayName, role: user.role },
        members: users.map((row: any) => ({
          id: num(row.id),
          displayName: row.display_name,
          email: row.email,
          role: row.role,
          color: row.color,
          icon: row.icon,
          hasAvatar: row.has_avatar,
          avatarUpdatedAt: row.avatar_updated_at,
        })),
        accounts: accounts.map((row: any) => ({
          id: num(row.id),
          name: row.name,
          kind: row.kind,
          ownerUserId: numOrNull(row.owner_user_id),
          orderIndex: num(row.order_index),
          icon: row.icon,
          color: row.color,
          balance: num(row.balance),
          /** チャージのときの出どころ。記録画面が自動で選ぶ */
          isChargeSource: !!row.is_charge_source,
          isPriority: priorityIds.has(num(row.id)),
        })),
        categories: categories.map(mapCategory),
        pools: pools.map((row: any) => ({
          id: num(row.id),
          name: row.name,
          purpose: row.purpose,
          targetAmount: numOrNull(row.target_amount),
          icon: row.icon,
          color: row.color,
          orderIndex: num(row.order_index),
          balance: num(row.balance),
        })),
        /** 未確定のクイック登録の件数。画面上部の呼び出しに使う */
        pendingStock: num(stock[0]?.pending),
      });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
