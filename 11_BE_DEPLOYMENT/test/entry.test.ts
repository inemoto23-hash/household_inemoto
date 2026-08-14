/**
 * normalizeEntry — 種別ごとの項目整合。
 *
 * DB の ck_entries_shape 制約のアプリ側鏡像がここ。
 * 制約そのもの（DB 側）は単体テストでは検証できない。
 * 「前の種別の値が残ったまま送られても必ず落とす」ことを固定する。
 */
import { describe, expect, it } from 'vitest';
import { monthRange, normalizeEntry, type EntryInput } from '../src/domain/entry';

const base: EntryInput = {
  entryDate: '2026-08-13',
  kind: 'expense',
  amount: 1000,
};

describe('normalizeEntry: transfer', () => {
  it('両口座が無ければ弾く（欠けている側の欄を指す）', () => {
    const r1 = normalizeEntry({ ...base, kind: 'transfer', counterAccountId: 2 });
    expect(r1.ok).toBe(false);
    expect(r1.field).toBe('accountId');

    const r2 = normalizeEntry({ ...base, kind: 'transfer', accountId: 1 });
    expect(r2.ok).toBe(false);
    expect(r2.field).toBe('counterAccountId');
  });

  it('同一口座は弾く', () => {
    const r = normalizeEntry({ ...base, kind: 'transfer', accountId: 1, counterAccountId: 1 });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('counterAccountId');
  });

  it('カテゴリとプールが送られてきても必ず null に落とす', () => {
    const r = normalizeEntry({
      ...base,
      kind: 'transfer',
      accountId: 1,
      counterAccountId: 2,
      budgetCategoryId: 9,
      poolId: 9,
    });
    expect(r.ok).toBe(true);
    expect(r.entry!.budgetCategoryId).toBeNull();
    expect(r.entry!.poolId).toBeNull();
    expect(r.entry!.accountId).toBe(1);
    expect(r.entry!.counterAccountId).toBe(2);
  });
});

describe('normalizeEntry: income', () => {
  it('accountId が無ければ弾く', () => {
    const r = normalizeEntry({ ...base, kind: 'income', budgetCategoryId: 1 });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('accountId');
  });

  it('カテゴリが無ければ弾く', () => {
    const r = normalizeEntry({ ...base, kind: 'income', accountId: 1 });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('budgetCategoryId');
  });

  it('counterAccountId と poolId が送られてきても必ず null に落とす', () => {
    const r = normalizeEntry({
      ...base,
      kind: 'income',
      accountId: 1,
      budgetCategoryId: 3,
      counterAccountId: 2,
      poolId: 4,
    });
    expect(r.ok).toBe(true);
    expect(r.entry!.counterAccountId).toBeNull();
    expect(r.entry!.poolId).toBeNull();
  });
});

describe('normalizeEntry: expense / refund（カテゴリ⊕プールの排他）', () => {
  for (const kind of ['expense', 'refund'] as const) {
    it(`${kind}: 両方指定は弾く`, () => {
      const r = normalizeEntry({ ...base, kind, accountId: 1, budgetCategoryId: 2, poolId: 3 });
      expect(r.ok).toBe(false);
      expect(r.field).toBe('budgetCategoryId');
    });

    it(`${kind}: どちらも無しは弾く`, () => {
      const r = normalizeEntry({ ...base, kind, accountId: 1 });
      expect(r.ok).toBe(false);
      expect(r.field).toBe('budgetCategoryId');
    });

    it(`${kind}: カテゴリのみ → poolId は null`, () => {
      const r = normalizeEntry({ ...base, kind, accountId: 1, budgetCategoryId: 2 });
      expect(r.ok).toBe(true);
      expect(r.entry!.budgetCategoryId).toBe(2);
      expect(r.entry!.poolId).toBeNull();
    });

    it(`${kind}: プールのみ → budgetCategoryId は null`, () => {
      const r = normalizeEntry({ ...base, kind, accountId: 1, poolId: 3 });
      expect(r.ok).toBe(true);
      expect(r.entry!.poolId).toBe(3);
      expect(r.entry!.budgetCategoryId).toBeNull();
    });
  }

  it('accountId が無ければ弾く', () => {
    const r = normalizeEntry({ ...base, budgetCategoryId: 2 });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('accountId');
  });

  it('空白だけの merchant / memo は null になる', () => {
    const r = normalizeEntry({
      ...base,
      accountId: 1,
      budgetCategoryId: 2,
      merchant: '   ',
      memo: '',
    });
    expect(r.ok).toBe(true);
    expect(r.entry!.merchant).toBeNull();
    expect(r.entry!.memo).toBeNull();
  });
});

describe('monthRange', () => {
  it('通常月と年跨ぎ', () => {
    expect(monthRange('2026-08')).toEqual({ from: '2026-08-01', toExclusive: '2026-09-01' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', toExclusive: '2027-01-01' });
  });

  it('不正な入力は null', () => {
    expect(monthRange('2026-13')).toBeNull();
    expect(monthRange('2026-00')).toBeNull();
    expect(monthRange('2026/08')).toBeNull();
    expect(monthRange('bad')).toBeNull();
  });
});
