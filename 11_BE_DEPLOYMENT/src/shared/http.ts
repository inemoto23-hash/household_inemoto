/**
 * HTTP レスポンスの共通形。
 * 成功は { data }、失敗は { error: { code, message } } に統一する。
 */
import { HttpResponseInit } from '@azure/functions';

export function ok<T>(data: T, status = 200): HttpResponseInit {
  return { status, jsonBody: { data } };
}

export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown
): HttpResponseInit {
  return { status, jsonBody: { error: { code, message, details } } };
}

/** 想定外の例外を 500 に畳み込む。詳細はログにだけ出し、利用者には返さない。 */
export function internalError(err: unknown, log: (msg: string) => void): HttpResponseInit {
  const message = err instanceof Error ? err.message : String(err);
  log(`UNHANDLED: ${message}`);
  return fail(500, 'INTERNAL_ERROR', '処理中にエラーが発生しました');
}
