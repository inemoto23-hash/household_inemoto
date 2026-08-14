/**
 * 月次締めの計算。
 *
 * ここは純粋関数だけで構成する。DB にも HTTP にも触れない。
 * 繰越の判定を間違えると「締めたら翌月の予算が狂う」という
 * 取り返しのつかない形でしか気付けないため、単体で確かめられるようにしておく。
 *
 * SQL の発行と行の取り出しは functions/periods.ts が担い、
 * ここは「その月の集計行 → 締めたときに何が動くか」だけを決める。
 * プレビューと実行が同じ関数を通る構造の、計算部分の本体。
 */
import { monthRange } from './entry';

/** 'YYYY-MM' の翌月 */
export function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' の前月 */
export function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** その月の末日。プール移動の日付に使う */
export function lastDay(ym: string): string {
  const range = monthRange(ym)!;
  const d = new Date(`${range.toExclusive}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export type CloseAction = 'none' | 'carry' | 'to_pool';

/** その月のカテゴリ別集計。DB の行から functions 側で詰め替える */
export interface CloseCategoryInput {
  categoryId: number;
  name: string;
  color: string | null;
  icon: string | null;
  /** carry_over_policy: 'none' | 'surplus' | 'full' | 'to_pool' */
  policy: string;
  allocated: number;
  spent: number;
  poolId: number | null;
  poolName: string | null;
}

export interface CloseLine extends CloseCategoryInput {
  remaining: number;
  action: CloseAction;
  /** 動く金額。action が none なら 0 */
  amount: number;
}

/**
 * 締めたときに何が起きるかを決める。
 *
 * - surplus: 余りが正のときだけ翌月へ
 * - full:    余りでも不足でも翌月へ（使いすぎた分はマイナスのまま渡す）
 * - to_pool: 余りが正で、移送先プールがあるときだけプールへ
 */
export function computeCloseLines(rows: CloseCategoryInput[]): CloseLine[] {
  return rows.map((row) => {
    const remaining = row.allocated - row.spent;

    let action: CloseAction = 'none';
    let amount = 0;

    if (row.policy === 'surplus' && remaining > 0) {
      action = 'carry';
      amount = remaining;
    } else if (row.policy === 'full' && remaining !== 0) {
      action = 'carry';
      amount = remaining;
    } else if (row.policy === 'to_pool' && remaining > 0 && row.poolId) {
      action = 'to_pool';
      amount = remaining;
    }

    return { ...row, remaining, action, amount };
  });
}
