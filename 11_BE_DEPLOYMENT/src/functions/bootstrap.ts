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
  return {
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
      const result = await pool.request().input('hid', sql.BigInt, user.householdId).query(`
        SELECT id, name FROM dbo.households WHERE id = @hid;

        SELECT id, display_name, email, role, color, icon,
               CAST(CASE WHEN avatar_data IS NULL THEN 0 ELSE 1 END AS BIT) AS has_avatar,
               avatar_updated_at, is_active
          FROM dbo.users
         WHERE household_id = @hid AND is_active = 1
         ORDER BY id;

        SELECT a.id, a.name, a.kind, a.owner_user_id, a.order_index, a.icon, a.color,
               b.balance
          FROM dbo.accounts a
          LEFT JOIN dbo.vw_account_balances b ON b.account_id = a.id
         WHERE a.household_id = @hid AND a.is_archived = 0
         ORDER BY a.order_index, a.name;

        SELECT id, name, kind, carry_over_policy, carry_over_pool_id, parent_id,
               icon, color, order_index, is_archived, default_amount
          FROM dbo.budget_categories
         WHERE household_id = @hid AND is_archived = 0
         ORDER BY kind DESC, order_index, name;

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
