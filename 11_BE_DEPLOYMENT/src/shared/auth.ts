/**
 * 認証: Entra が発行した JWT を JWKS で検証する。
 *
 * Azure の組み込み認証(EasyAuth)に依存しないため、ホスティング構成を
 * 変えても壊れない。SWA の Linked Backend でも直接呼び出しでも同じコードで動く。
 */
import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createRemoteJWKSet, jwtVerify, decodeJwt, JWTPayload } from 'jose';
import { getPool, sql } from '../db/pool';
import { num } from '../db/convert';
import { fail } from './http';

export interface AuthedUser {
  id: number;
  householdId: number;
  email: string;
  displayName: string;
  role: string;
}

export function isOwner(user: AuthedUser): boolean {
  return user.role === 'owner';
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

const USER_COLUMNS = `id, household_id, email, display_name, role`;

function toAuthedUser(row: Record<string, any>): AuthedUser {
  return {
    // BIGINT は文字列で返るため必ず number へ正規化する
    id: num(row.id),
    householdId: num(row.household_id),
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
}

/**
 * users テーブルへ引き当てる。
 *
 * 1. Entra の oid で照合する（2回目以降のサインイン）
 * 2. 見つからなければ、招待済み（provider_user_id が未設定）の行をメールアドレスで探し、
 *    見つかれば oid を書き込んで確定する（初回サインイン）
 *
 * メールアドレスは Entra が検証したクレームのみを使う。リクエスト本文の値は決して使わない。
 */
async function resolveUser(oid: string, emails: string[]): Promise<AuthedUser | null> {
  const pool = await getPool();

  const byOid = await pool
    .request()
    .input('oid', sql.NVarChar(200), oid)
    .query(`SELECT TOP 1 ${USER_COLUMNS} FROM dbo.users WHERE provider_user_id = @oid AND is_active = 1`);

  if (byOid.recordset[0]) return toAuthedUser(byOid.recordset[0]);

  // 初回サインイン: 招待済みの行をメールアドレスで引き当てて紐付ける
  for (const email of emails) {
    const bound = await pool
      .request()
      .input('oid', sql.NVarChar(200), oid)
      .input('email', sql.NVarChar(256), email)
      .query(
        `UPDATE dbo.users
            SET provider_user_id = @oid
          OUTPUT ${USER_COLUMNS.split(', ').map((c) => `INSERTED.${c}`).join(', ')}
          WHERE email = @email
            AND provider_user_id IS NULL
            AND is_active = 1`
      );

    if (bound.recordset[0]) return toAuthedUser(bound.recordset[0]);
  }

  return null;
}

/** トークンから、照合に使えるメールアドレスの候補を取り出す */
function emailCandidates(claims: JWTPayload): string[] {
  const raw = [
    claims.email,
    claims.preferred_username,
    (claims as Record<string, unknown>).upn,
  ];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value === 'string' && value.includes('@')) {
      seen.add(value.toLowerCase());
      // ゲストの UPN は inemoto23_gmail.com#EXT#@tenant.onmicrosoft.com の形になる。
      // 元のメールアドレスへ復元して照合できるようにする
      const ext = value.match(/^(.+?)#EXT#@/);
      if (ext) seen.add(ext[1].replace(/_(?=[^_]*$)/, '@').toLowerCase());
    }
  }
  return [...seen];
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
        // アプリ登録を v2 に切り替えても、切り替え前に発行された v1 トークンが
        // ブラウザのキャッシュに残るため、当面は両方の発行者を受け付ける
        issuer: [
          `https://login.microsoftonline.com/${tenantId}/v2.0`,
          `https://sts.windows.net/${tenantId}/`,
        ],
        audience: [audience, `api://${audience}`],
      });
      claims = verified.payload;
    } catch (err) {
      // 何が食い違ったのかを返す。トークンは呼び出し元が既に持っているものなので
      // ここで iss / aud を見せても新たな情報漏洩にはならず、切り分けが一気に楽になる
      let actual: Record<string, unknown> | undefined;
      try {
        const raw = decodeJwt(bearer);
        actual = { iss: raw.iss, aud: raw.aud, ver: (raw as Record<string, unknown>).ver };
      } catch {
        actual = { note: 'トークンを JWT として解析できませんでした' };
      }
      const reason = err instanceof Error ? err.message : String(err);
      ctx.warn(`token verification failed: ${reason} / actual=${JSON.stringify(actual)}`);

      return fail(
        401,
        'INVALID_TOKEN',
        'サインインし直してください',
        {
          reason,
          actual,
          expected: {
            iss: [
              `https://login.microsoftonline.com/${tenantId}/v2.0`,
              `https://sts.windows.net/${tenantId}/`,
            ],
            aud: [audience, `api://${audience}`],
          },
        }
      );
    }

    const oid = (claims.oid ?? claims.sub) as string | undefined;
    if (!oid) {
      return fail(401, 'INVALID_TOKEN', 'トークンに利用者識別子が含まれていません');
    }

    const emails = emailCandidates(claims);
    const user = await resolveUser(oid, emails);
    if (!user) {
      return fail(403, 'NOT_A_MEMBER', 'この世帯のメンバーとして登録されていません', {
        oid,
        triedEmails: emails,
        hint: 'オーナーに、この メールアドレス でメンバー追加してもらってください',
      });
    }

    return handler(req, ctx, { user, claims });
  };
}
