/**
 * 世帯メンバー管理。
 *
 * Entra のゲスト招待は管理者がポータルで行う必要があるが、
 * users テーブルへの登録・更新はここで完結する。
 *
 * 招待の流れ:
 *   1. オーナーが POST /api/members でメールアドレスと表示名を登録
 *      → provider_user_id が NULL の「招待中」の行ができる
 *   2. 本人が初めてサインインすると withAuth が oid を紐付けて確定する
 */
import { app } from '@azure/functions';
import { z } from 'zod';
import { getPool, sql } from '../db/pool';
import { num } from '../db/convert';
import { ok, fail, internalError } from '../shared/http';
import { withAuth, isOwner, AuthedUser } from '../shared/auth';

const SELECT_MEMBER = `
  SELECT u.id,
         u.email,
         u.display_name,
         u.role,
         u.color,
         u.icon,
         u.avatar_updated_at,
         u.is_active,
         u.invited_at,
         u.created_at,
         CAST(CASE WHEN u.provider_user_id IS NULL THEN 1 ELSE 0 END AS BIT) AS is_pending,
         CAST(CASE WHEN u.avatar_data      IS NULL THEN 0 ELSE 1 END AS BIT) AS has_avatar,
         (SELECT COUNT(*) FROM dbo.user_account_priorities p WHERE p.user_id = u.id) AS priority_count
    FROM dbo.users u
`;

function mapMember(row: Record<string, any>) {
  return {
    id: num(row.id),
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    color: row.color,
    icon: row.icon,
    isActive: row.is_active,
    invitedAt: row.invited_at,
    createdAt: row.created_at,
    /** true = 招待済みだがまだ一度もサインインしていない */
    isPending: row.is_pending,
    /** 画像アバターの有無。取得は GET /api/members/{id}/avatar */
    hasAvatar: row.has_avatar,
    /** 画像の更新時刻。キャッシュの鍵に使う */
    avatarUpdatedAt: row.avatar_updated_at,
    /** 優先表示に選んでいる財布の数。設定は PUT /api/members/{id}/account-priorities で行う */
    priorityCount: num(row.priority_count),
  };
}

// ---------------------------------------------------------------
// 一覧
// ---------------------------------------------------------------
app.http('membersList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'members',
  handler: withAuth(async (_req, ctx, { user }) => {
    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .query(`${SELECT_MEMBER} WHERE u.household_id = @hid ORDER BY u.is_active DESC, u.id`);

      return ok(result.recordset.map(mapMember));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 追加（オーナーのみ）
// ---------------------------------------------------------------
const createSchema = z.object({
  email: z.string().trim().min(3).max(256).email('メールアドレスの形式が正しくありません'),
  displayName: z.string().trim().min(1, '表示名を入力してください').max(100),
  role: z.enum(['owner', 'member']).default('member'),
  color: z.string().trim().max(20).optional(),
});

app.http('membersCreate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'members',
  handler: withAuth(async (req, ctx, { user }) => {
    if (!isOwner(user)) {
      return fail(403, 'FORBIDDEN', 'メンバーを追加できるのはオーナーだけです');
    }

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;
    const email = input.email.toLowerCase();

    try {
      const pool = await getPool();

      const duplicate = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('email', sql.NVarChar(256), email)
        .query(`SELECT TOP 1 id, is_active FROM dbo.users WHERE household_id = @hid AND email = @email`);

      if (duplicate.recordset[0]) {
        return fail(409, 'ALREADY_EXISTS', 'このメールアドレスは既に登録されています');
      }

      const inserted = await pool
        .request()
        .input('hid', sql.BigInt, user.householdId)
        .input('email', sql.NVarChar(256), email)
        .input('name', sql.NVarChar(100), input.displayName)
        .input('role', sql.NVarChar(20), input.role)
        .input('color', sql.NVarChar(20), input.color ?? null)
        .input('by', sql.BigInt, user.id)
        .query(
          `INSERT INTO dbo.users (household_id, email, display_name, role, color, invited_at, invited_by)
           OUTPUT INSERTED.id
           VALUES (@hid, @email, @name, @role, @color, SYSUTCDATETIME(), @by)`
        );

      const created = await pool
        .request()
        .input('id', sql.BigInt, inserted.recordset[0].id)
        .query(`${SELECT_MEMBER} WHERE u.id = @id`);

      return ok(mapMember(created.recordset[0]), 201);
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 更新（オーナーは全員、本人は自分のみ）
// ---------------------------------------------------------------
const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    color: z.string().trim().max(20).nullable().optional(),
    // 絵文字1〜2文字を想定。長い文字列で表示を崩されないよう上限を設ける
    icon: z.string().trim().max(16).nullable().optional(),
    role: z.enum(['owner', 'member']).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '更新する項目がありません' });

/** 最後のオーナーを失わせる操作を拒否する */
async function wouldRemoveLastOwner(
  targetId: number,
  householdId: number,
  next: { role?: string; isActive?: boolean }
): Promise<boolean> {
  const demoting = next.role === 'member';
  const deactivating = next.isActive === false;
  if (!demoting && !deactivating) return false;

  const pool = await getPool();
  const result = await pool
    .request()
    .input('hid', sql.BigInt, householdId)
    .input('id', sql.BigInt, targetId)
    .query(
      `SELECT COUNT(*) AS others
         FROM dbo.users
        WHERE household_id = @hid AND role = 'owner' AND is_active = 1 AND id <> @id`
    );

  return result.recordset[0].others === 0;
}

app.http('membersUpdate', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'members/{id}',
  handler: withAuth(async (req, ctx, { user }) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return fail(400, 'VALIDATION_ERROR', 'メンバーIDが不正です');
    }

    const isSelf = targetId === user.id;
    if (!isOwner(user) && !isSelf) {
      return fail(403, 'FORBIDDEN', '他のメンバーの設定は変更できません');
    }

    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'VALIDATION_ERROR', '入力内容を確認してください', parsed.error.flatten());
    }
    const input = parsed.data;

    // 権限と有効/無効はオーナーだけが変えられる
    if (!isOwner(user) && (input.role !== undefined || input.isActive !== undefined)) {
      return fail(403, 'FORBIDDEN', '権限の変更はオーナーだけが行えます');
    }

    try {
      const pool = await getPool();

      const target = await pool
        .request()
        .input('id', sql.BigInt, targetId)
        .input('hid', sql.BigInt, user.householdId)
        .query(`SELECT TOP 1 id FROM dbo.users WHERE id = @id AND household_id = @hid`);

      if (!target.recordset[0]) {
        return fail(404, 'NOT_FOUND', 'メンバーが見つかりません');
      }

      if (await wouldRemoveLastOwner(targetId, user.householdId, input)) {
        return fail(409, 'LAST_OWNER', '最後のオーナーは権限変更・無効化できません');
      }

      const sets: string[] = [];
      const request = pool.request().input('id', sql.BigInt, targetId);

      if (input.displayName !== undefined) {
        sets.push('display_name = @name');
        request.input('name', sql.NVarChar(100), input.displayName);
      }
      if (input.color !== undefined) {
        sets.push('color = @color');
        request.input('color', sql.NVarChar(20), input.color);
      }
      if (input.icon !== undefined) {
        sets.push('icon = @icon');
        request.input('icon', sql.NVarChar(16), input.icon);
      }
      if (input.role !== undefined) {
        sets.push('role = @role');
        request.input('role', sql.NVarChar(20), input.role);
      }
      if (input.isActive !== undefined) {
        sets.push('is_active = @active');
        request.input('active', sql.Bit, input.isActive);
      }

      await request.query(`UPDATE dbo.users SET ${sets.join(', ')} WHERE id = @id`);

      const updated = await pool
        .request()
        .input('id', sql.BigInt, targetId)
        .query(`${SELECT_MEMBER} WHERE u.id = @id`);

      return ok(mapMember(updated.recordset[0]));
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 無効化（オーナーのみ。物理削除はしない）
// ---------------------------------------------------------------
app.http('membersDeactivate', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'members/{id}',
  handler: withAuth(async (req, ctx, { user }: { user: AuthedUser }) => {
    if (!isOwner(user)) {
      return fail(403, 'FORBIDDEN', 'メンバーを無効化できるのはオーナーだけです');
    }

    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return fail(400, 'VALIDATION_ERROR', 'メンバーIDが不正です');
    }

    try {
      if (await wouldRemoveLastOwner(targetId, user.householdId, { isActive: false })) {
        return fail(409, 'LAST_OWNER', '最後のオーナーは無効化できません');
      }

      const pool = await getPool();
      const result = await pool
        .request()
        .input('id', sql.BigInt, targetId)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `UPDATE dbo.users SET is_active = 0
            OUTPUT INSERTED.id
            WHERE id = @id AND household_id = @hid`
        );

      if (!result.recordset[0]) {
        return fail(404, 'NOT_FOUND', 'メンバーが見つかりません');
      }

      return ok({ id: targetId, isActive: false });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
