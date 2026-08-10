/**
 * Azure SQL 接続プール
 *
 * 接続文字列もパスワードも保持しない。マネージドID（ローカル開発では az login）から
 * Entra のアクセストークンを取得して接続する。
 * トークンには有効期限があるため、期限が近づいたらプールを作り直す。
 */
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const SQL_SCOPE = 'https://database.windows.net/.default';
/** 期限のこれだけ手前で作り直す（ミリ秒） */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const credential = new DefaultAzureCredential();

let poolPromise: Promise<sql.ConnectionPool> | null = null;
let tokenExpiresOn = 0;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

async function createPool(): Promise<sql.ConnectionPool> {
  const token = await credential.getToken(SQL_SCOPE);
  if (!token) throw new Error('Entra からアクセストークンを取得できませんでした');
  tokenExpiresOn = token.expiresOnTimestamp;

  const pool = new sql.ConnectionPool({
    server: requiredEnv('SQL_SERVER'),
    database: requiredEnv('SQL_DATABASE'),
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: token.token },
    },
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 8, min: 0, idleTimeoutMillis: 60_000 },
    connectionTimeout: 30_000,
    requestTimeout: 60_000,
  });

  // 接続が落ちたら次回は作り直す
  pool.on('error', () => {
    poolPromise = null;
  });

  return pool.connect();
}

export async function getPool(): Promise<sql.ConnectionPool> {
  if (poolPromise && Date.now() < tokenExpiresOn - REFRESH_MARGIN_MS) {
    return poolPromise;
  }

  // 期限切れ間近の古いプールは閉じる（失敗しても無視してよい）
  if (poolPromise) {
    const stale = poolPromise;
    poolPromise = null;
    stale.then((p) => p.close()).catch(() => undefined);
  }

  poolPromise = createPool().catch((err) => {
    poolPromise = null;
    throw err;
  });
  return poolPromise;
}

export { sql };
