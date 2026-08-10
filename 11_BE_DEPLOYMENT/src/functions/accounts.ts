/**
 * 口座（財布・クレジット）の参照と、利用者ごとの優先表示設定。
 *
 * 口座は数が多く今後も増減するため、選択欄では「よく使う財布」を先頭へ出す。
 * 並び順は口座自体の order_index を流用し、利用者に並べ替えを求めない。
 * 本格的な口座管理（追加・編集）は Phase 1 で追加する。
 */
import { app } from '@azure/functions';
import { z } from 'zod';
import { getPool, sql } from '../db/pool';
import { num, numOrNull } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth, isOwner } from '../shared/auth';

/** 直近の利用実績を見る期間（日） */
const RECENT_DAYS = 90;

// ---------------------------------------------------------------
// 一覧（優先表示フラグと直近利用を含む）
// ---------------------------------------------------------------
app.http('accountsList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'accounts',
  handler: withAuth(async (req, ctx, { user }) => {
    const includeArchived = req.query.get('includeArchived') === 'true';
    // 他メンバーの優先設定を編集する画面用。既定は自分の設定
    const forUserId = Number(req.query.get('forUserId') ?? user.id);
    if (!Number.isInteger(forUserId) || forUserId <= 0) {
      return fail(400, 'VALIDATION_ERROR', '利用者IDが不正です');
    }

    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('uid', sql.BigInt, forUserId)
        .input('days', sql.Int, RECENT_DAYS)
        .query(
          `SELECT a.id, a.name, a.kind, a.owner_user_id, a.order_index, a.is_archived,
                  a.icon, a.color, b.balance,
                  a.opening_balance, a.opening_date,
                  a.closing_day, a.payment_day, a.payment_account_id,
                  CAST(CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS BIT) AS is_priority,
                  u.last_used_at,
                  ISNULL(u.use_count, 0) AS recent_use_count
             FROM dbo.accounts a
             LEFT JOIN dbo.vw_account_balances b ON b.account_id = a.id
             LEFT JOIN dbo.user_account_priorities p
                    ON p.account_id = a.id AND p.user_id = @uid
             OUTER APPLY (
                 SELECT MAX(e.entry_date) AS last_used_at, COUNT(*) AS use_count
                   FROM dbo.entries e
                  WHERE e.account_id = a.id
                    AND e.created_by = @uid
                    AND e.is_deleted = 0
                    AND e.entry_date >= DATEADD(day, -@days, CAST(SYSUTCDATETIME() AS date))
             ) u
            WHERE a.household_id = @hid
              ${includeArchived ? '' : 'AND a.is_archived = 0'}
            ORDER BY is_priority DESC, a.order_index, a.name`
        );

      return ok(
        result.recordset.map((row) => ({
          id: num(row.id),
          name: row.name,
          kind: row.kind,
          ownerUserId: numOrNull(row.owner_user_id),
          orderIndex: num(row.order_index),
          isArchived: row.is_archived,
          icon: row.icon,
          color: row.color,
          // 管理画面の編集フォーム用。一覧表示では使わない
          openingBalance: num(row.opening_balance),
          openingDate: row.opening_date,
          closingDay: numOrNull(row.closing_day),
          paymentDay: numOrNull(row.payment_day),
          paymentAccountId: numOrNull(row.payment_account_id),
          // クレジットは残高がマイナス方向へ積み上がる。画面では利用額として見せる
          balance: num(row.balance),
          /** この利用者が優先表示に選んでいるか */
          isPriority: row.is_priority,
          /** 初期選択の決定に使う。優先財布のうち直近に使ったものを選ぶ */
          lastUsedAt: row.last_used_at,
          recentUseCount: num(row.recent_use_count),
        }))
      );
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 優先表示の設定（自分の分。オーナーは他メンバーの分も設定できる）
// ---------------------------------------------------------------
const prioritySchema = z.object({
  // 念のため文字列で送られても受け取れるようにしておく
  accountIds: z.array(z.coerce.number().int().positive()).max(50),
});

app.http('accountPrioritiesUpdate', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'members/{id}/account-priorities',
  handler: withAuth(async (req, ctx, { user }) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return fail(400, 'VALIDATION_ERROR', 'メンバーIDが不正です');
    }
    if (targetId !== user.id && !isOwner(user)) {
      return fail(403, 'FORBIDDEN', '他のメンバーの設定は変更できません');
    }

    const parsed = prioritySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const accountIds = [...new Set(parsed.data.accountIds)];

    const pool = await getPool();
    const transaction = new sql.Transaction(pool);

    try {
      // 対象メンバーが同じ世帯にいることを確かめる
      const member = await pool
        .request()
        .input('id', sql.BigInt, targetId)
        .input('hid', sql.BigInt, user.householdId)
        .query(`SELECT TOP 1 id FROM dbo.users WHERE id = @id AND household_id = @hid`);
      if (!member.recordset[0]) {
        return fail(404, 'NOT_FOUND', 'メンバーが見つかりません');
      }

      // 指定された口座がすべて同じ世帯のものか確かめる。
      // accountIds は Zod で正の整数のみに絞り込み済みのため、IN 句へ直接埋めても安全
      if (accountIds.length > 0) {
        const check = await pool
          .request()
          .input('hid', sql.BigInt, user.householdId)
          .query(
            `SELECT COUNT(*) AS ok FROM dbo.accounts
              WHERE household_id = @hid AND id IN (${accountIds.join(',')})`
          );
        if (check.recordset[0].ok !== accountIds.length) {
          return fail(400, 'VALIDATION_ERROR', '指定された財布の中に、この世帯のものでないものがあります');
        }
      }

      // 総入れ替え。差分計算より単純で、件数も高々数十件
      await transaction.begin();
      await new sql.Request(transaction)
        .input('uid', sql.BigInt, targetId)
        .query(`DELETE FROM dbo.user_account_priorities WHERE user_id = @uid`);

      for (const accountId of accountIds) {
        await new sql.Request(transaction)
          .input('uid', sql.BigInt, targetId)
          .input('aid', sql.BigInt, accountId)
          .query(
            `INSERT INTO dbo.user_account_priorities (user_id, account_id) VALUES (@uid, @aid)`
          );
      }
      await transaction.commit();

      return ok({ userId: targetId, accountIds });
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
