/**
 * 利用者のアバター画像。
 *
 * 画像は DB（users.avatar_data）に持つ。ストレージは共有キーを禁止しているため
 * ブラウザへ直接見せるには利用者委任SASが要り、数十KBの画像には構成が重すぎる。
 * クライアント側で 256px 以下へ縮小してから送る前提。
 *
 * 取得はトークンが要るため <img src> では読めない。画面側で fetch して
 * オブジェクトURLを作る（features/members/useAvatar.ts）。
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getPool, sql } from '../db/pool';
import { ok, fail, internalError } from '../shared/http';
import { withAuth, isOwner, AuthContext } from '../shared/auth';

/** 縮小後の画像を想定した上限。これを超えるなら送る前の縮小が効いていない */
const MAX_BYTES = 512 * 1024;
const ALLOWED_MIME = new Set(['image/webp', 'image/jpeg', 'image/png']);

function parseTargetId(req: HttpRequest): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------
// 取得
// ---------------------------------------------------------------
app.http('avatarGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'members/{id}/avatar',
  handler: withAuth(async (req, ctx, { user }) => {
    const targetId = parseTargetId(req);
    if (targetId === null) return fail(400, 'VALIDATION_ERROR', 'メンバーIDが不正です');

    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('id', sql.BigInt, targetId)
        .input('hid', sql.BigInt, user.householdId)
        .query(
          `SELECT TOP 1 avatar_data, avatar_mime, avatar_updated_at
             FROM dbo.users WHERE id = @id AND household_id = @hid`
        );

      const row = result.recordset[0];
      if (!row) return fail(404, 'NOT_FOUND', 'メンバーが見つかりません');
      if (!row.avatar_data) return fail(404, 'NO_AVATAR', '画像が設定されていません');

      return {
        status: 200,
        headers: {
          'Content-Type': row.avatar_mime ?? 'application/octet-stream',
          // 世帯内でのみ意味を持つ画像なので共有キャッシュには載せない
          'Cache-Control': 'private, max-age=300',
        },
        body: row.avatar_data as Buffer,
      };
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 更新（本人、またはオーナー）
// ---------------------------------------------------------------
async function assertCanEdit(
  targetId: number,
  { user }: AuthContext
): Promise<HttpResponseInit | null> {
  if (targetId !== user.id && !isOwner(user)) {
    return fail(403, 'FORBIDDEN', '他のメンバーのアイコンは変更できません');
  }
  const pool = await getPool();
  const found = await pool
    .request()
    .input('id', sql.BigInt, targetId)
    .input('hid', sql.BigInt, user.householdId)
    .query(`SELECT TOP 1 1 AS ok FROM dbo.users WHERE id = @id AND household_id = @hid`);
  return found.recordset[0] ? null : fail(404, 'NOT_FOUND', 'メンバーが見つかりません');
}

app.http('avatarPut', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'members/{id}/avatar',
  handler: withAuth(async (req: HttpRequest, ctx: InvocationContext, auth) => {
    const targetId = parseTargetId(req);
    if (targetId === null) return fail(400, 'VALIDATION_ERROR', 'メンバーIDが不正です');

    const denied = await assertCanEdit(targetId, auth);
    if (denied) return denied;

    const mime = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      return fail(400, 'UNSUPPORTED_TYPE', 'WebP / JPEG / PNG の画像を選んでください', {
        received: mime,
      });
    }

    try {
      const buffer = Buffer.from(await req.arrayBuffer());
      if (buffer.length === 0) {
        return fail(400, 'VALIDATION_ERROR', '画像が空です');
      }
      if (buffer.length > MAX_BYTES) {
        return fail(413, 'TOO_LARGE', '画像が大きすぎます。小さい画像を選んでください', {
          bytes: buffer.length,
          maxBytes: MAX_BYTES,
        });
      }

      const pool = await getPool();
      await pool
        .request()
        .input('id', sql.BigInt, targetId)
        .input('data', sql.VarBinary(sql.MAX), buffer)
        .input('mime', sql.NVarChar(50), mime)
        .query(
          `UPDATE dbo.users
              SET avatar_data = @data, avatar_mime = @mime, avatar_updated_at = SYSUTCDATETIME()
            WHERE id = @id`
        );

      return ok({ id: targetId, bytes: buffer.length, mime });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});

// ---------------------------------------------------------------
// 削除
// ---------------------------------------------------------------
app.http('avatarDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'members/{id}/avatar',
  handler: withAuth(async (req, ctx, auth) => {
    const targetId = parseTargetId(req);
    if (targetId === null) return fail(400, 'VALIDATION_ERROR', 'メンバーIDが不正です');

    const denied = await assertCanEdit(targetId, auth);
    if (denied) return denied;

    try {
      const pool = await getPool();
      await pool
        .request()
        .input('id', sql.BigInt, targetId)
        .query(
          `UPDATE dbo.users
              SET avatar_data = NULL, avatar_mime = NULL, avatar_updated_at = NULL
            WHERE id = @id`
        );

      return ok({ id: targetId, hasAvatar: false });
    } catch (err) {
      return internalError(err, (m) => ctx.error(m));
    }
  }),
});
