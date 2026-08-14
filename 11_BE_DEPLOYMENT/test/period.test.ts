/**
 * 月次締めの計算 — 繰越の判定を間違えると「締めたら翌月の予算が狂う」
 * という取り返しのつかない形でしか気付けない。
 * プレビューと実行が共有する計算の本体（computeCloseLines）をここで固定する。
 */
import { describe, expect, it } from 'vitest';
import {
  computeCloseLines,
  lastDay,
  nextMonth,
  prevMonth,
  type CloseCategoryInput,
} from '../src/domain/period';

const cat = (over: Partial<CloseCategoryInput>): CloseCategoryInput => ({
  categoryId: 1,
  name: '食費',
  color: null,
  icon: null,
  policy: 'none',
  allocated: 20_000,
  spent: 15_000,
  poolId: null,
  poolName: null,
  ...over,
});

const one = (over: Partial<CloseCategoryInput>) => computeCloseLines([cat(over)])[0];

describe('computeCloseLines: remaining', () => {
  it('remaining = allocated - spent。入力の項目はそのまま残る', () => {
    const line = one({ allocated: 20_000, spent: 15_000 });
    expect(line.remaining).toBe(5_000);
    expect(line.categoryId).toBe(1);
    expect(line.name).toBe('食費');
    expect(line.policy).toBe('none');
  });
});

describe('computeCloseLines: policy = none', () => {
  it('余っても何もしない', () => {
    const line = one({ policy: 'none', allocated: 20_000, spent: 10_000 });
    expect(line.action).toBe('none');
    expect(line.amount).toBe(0);
  });
});

describe('computeCloseLines: policy = surplus', () => {
  it('余りが正なら翌月へ', () => {
    const line = one({ policy: 'surplus', allocated: 20_000, spent: 15_000 });
    expect(line.action).toBe('carry');
    expect(line.amount).toBe(5_000);
  });

  it('ちょうど使い切り・使いすぎは何もしない（不足は渡さない）', () => {
    expect(one({ policy: 'surplus', allocated: 20_000, spent: 20_000 }).action).toBe('none');
    expect(one({ policy: 'surplus', allocated: 20_000, spent: 25_000 }).action).toBe('none');
  });
});

describe('computeCloseLines: policy = full', () => {
  it('余りは正のまま渡す', () => {
    const line = one({ policy: 'full', allocated: 20_000, spent: 15_000 });
    expect(line.action).toBe('carry');
    expect(line.amount).toBe(5_000);
  });

  it('使いすぎた分はマイナスのまま渡す（翌月から差し引く）', () => {
    const line = one({ policy: 'full', allocated: 20_000, spent: 26_000 });
    expect(line.action).toBe('carry');
    expect(line.amount).toBe(-6_000);
  });

  it('ちょうど使い切りは何もしない', () => {
    expect(one({ policy: 'full', allocated: 20_000, spent: 20_000 }).action).toBe('none');
  });
});

describe('computeCloseLines: policy = to_pool', () => {
  it('余りが正で移送先があるならプールへ', () => {
    const line = one({ policy: 'to_pool', allocated: 20_000, spent: 15_000, poolId: 7, poolName: '旅行' });
    expect(line.action).toBe('to_pool');
    expect(line.amount).toBe(5_000);
    expect(line.poolId).toBe(7);
  });

  it('移送先プールが無ければ何もしない', () => {
    expect(one({ policy: 'to_pool', allocated: 20_000, spent: 15_000, poolId: null }).action).toBe('none');
  });

  it('不足はプールへ渡さない', () => {
    expect(one({ policy: 'to_pool', allocated: 20_000, spent: 25_000, poolId: 7 }).action).toBe('none');
  });
});

describe('nextMonth / prevMonth', () => {
  it('年を跨ぐ', () => {
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(prevMonth('2026-01')).toBe('2025-12');
  });

  it('通常月', () => {
    expect(nextMonth('2026-08')).toBe('2026-09');
    expect(prevMonth('2026-08')).toBe('2026-07');
  });
});

describe('lastDay', () => {
  it('月末（31日・30日・2月・閏年）', () => {
    expect(lastDay('2026-08')).toBe('2026-08-31');
    expect(lastDay('2026-09')).toBe('2026-09-30');
    expect(lastDay('2026-02')).toBe('2026-02-28');
    expect(lastDay('2028-02')).toBe('2028-02-29');
    expect(lastDay('2026-12')).toBe('2026-12-31');
  });
});
