/**
 * ゼロサムペア — 「同一 transfer_group_id で ±N、合計 0」の決まりは
 * 組み換え・プール出し入れ・締めの移送の3箇所が共有する。
 * 対をここでしか作れないことが、符号が片側だけ逆になる事故への対策そのもの。
 */
import { describe, expect, it } from 'vitest';
import { buildTransferPair } from '../src/domain/allocation';

describe('buildTransferPair', () => {
  it('出る側は負・入る側は正で、合計は必ず 0', () => {
    const pair = buildTransferPair(5_000, 'group-1');
    expect(pair.outAmount).toBe(-5_000);
    expect(pair.inAmount).toBe(5_000);
    expect(pair.outAmount + pair.inAmount).toBe(0);
  });

  it('groupId は渡したものがそのまま両行に使われる', () => {
    expect(buildTransferPair(1, 'abc').groupId).toBe('abc');
  });

  it('0・負・小数は作れない（ゼロサムが成立しない対を生ませない）', () => {
    expect(() => buildTransferPair(0, 'g')).toThrow();
    expect(() => buildTransferPair(-100, 'g')).toThrow();
    expect(() => buildTransferPair(100.5, 'g')).toThrow();
  });
});
