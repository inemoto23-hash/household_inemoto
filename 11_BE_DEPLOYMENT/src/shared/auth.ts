/**
 * 認証: Entra が発行した JWT を JWKS で検証する。
 *
 * Azure の組み込み認証(EasyAuth)に依存しないため、ホスティング構成を
 * 変えても壊れない。SWA の Linked Backend でも直接呼び出しでも同じコードで動く。
 */
import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { getPool, sql } from '../db/pool';
import { fail } from './http';

export interface AuthedUser {
  id: number;
  householdId: number;
  email: string;
  displayName: string;
  role: string;
}

export interface AuthContext {
  user: AuthedUser;
  claims: JWTPayload;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    const tenantId = process.env.TENANT_ID;
    if (!tenantId) throw new Error('環境変数 TENANT_ID が設定されていません');
    jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
    );
  }
  return jwks;
}

/** users テーブルへ引き当てる。未登録なら null（＝世帯メンバーではない）。 */
async function resolveUser(oid: string): Promise<AuthedUser | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('oid', sql.NVarChar(200), oid)
    .query(
      `SELECT TOP 1 id, household_id, email, display_name, role
         FROM dbo.users
        WHERE provider_user_id = @oid AND is_active = 1`
    );

  const row = result.recordset[0];
  if (!row) return null;
  return {
    id: row.id,
    householdId: row.household_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
}

export type AuthedHandler = (
  req: HttpRequest,
  ctx: InvocationContext,
  auth: AuthContext
) => Promise<HttpResponseInit>;

/**
 * 認証を必須にするラッパ。
 * すべてのデータ系エンドポイントはこれを通すこと。householdId は
 * ここで確定した値のみを使い、リクエスト本文の値は決して信用しない。
 */
export function withAuth(handler: AuthedHandler) {
  return async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    const header = req.headers.get('authorization');
    const bearer = header?.replace(/^Bearer\s+/i, '');
    if (!bearer) {
      return fail(401, 'UNAUTHENTICATED', 'サインインが必要です');
    }

    const tenantId = process.env.TENANT_ID;
    const audience = process.env.API_CLIENT_ID;
    if (!tenantId || !audience) {
      ctx.error('TENANT_ID / API_CLIENT_ID が未設定です');
      return fail(500, 'CONFIG_ERROR', 'サーバー設定が不完全です');
    }

    let claims: JWTPayload;
    try {
      const verified = await jwtVerify(bearer, getJwks(), {
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        audience: [audience, `api://${audience}`],
      });
      claims = verified.payload;
    } catch (err) {
      ctx.warn(`token verification failed: ${err instanceof Error ? err.message : err}`);
      return fail(401, 'INVALID_TOKEN', 'サインインの有効期限が切れています。再度サインインしてください');
    }

    const oid = (claims.oid ?? claims.sub) as string | undefined;
    if (!oid) {
      return fail(401, 'INVALID_TOKEN', 'トークンに利用者識別子が含まれていません');
    }

    const user = await resolveUser(oid);
    if (!user) {
      return fail(403, 'NOT_A_MEMBER', 'この世帯のメンバーとして登録されていません');
    }

    return handler(req, ctx, { user, claims });
  };
}
