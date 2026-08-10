/**
 * DB の値を API の型へ正規化する。
 *
 * node-mssql は精度欠落を避けるため BIGINT を **文字列** で返す。
 * ID も金額もすべて BIGINT で持つ設計のため、変換を1箇所に集約し、
 * JSON へ出す時点では必ず number になっている状態を保証する。
 *
 * 家計簿の扱う範囲（ID は数千、金額は円単位で高々10桁）は
 * Number.MAX_SAFE_INTEGER (約9007兆) に遠く及ばないため、
 * number への変換で精度を失うことはない。
 */

/** BIGINT/DECIMAL を number に。null や undefined は 0 にする */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`数値へ変換できない値です: ${String(value)}`);
  }
  return n;
}

/** BIGINT を number に。null はそのまま null を保つ */
export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return num(value);
}
