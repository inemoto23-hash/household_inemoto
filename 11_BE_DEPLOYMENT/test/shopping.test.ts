/**
 * 買い物メモの入力検証 — 空白だけの品名が入ると、押せない・消せない行が
 * 一覧に居座る。DB の ck_shop_name と同じことをアプリ側でも見ている。
 */
import { describe, expect, it } from 'vitest';
import { shoppingItemInputSchema, shoppingItemPatchSchema } from '../src/domain/shopping';

describe('shoppingItemInputSchema', () => {
  it('日付と品名が揃っていれば通る', () => {
    const r = shoppingItemInputSchema.safeParse({ plannedOn: '2026-08-15', name: '牛乳' });
    expect(r.success).toBe(true);
  });

  it('品名の前後の空白は落とす', () => {
    const r = shoppingItemInputSchema.parse({ plannedOn: '2026-08-15', name: '  牛乳  ' });
    expect(r.name).toBe('牛乳');
  });

  it('空文字は弾く', () => {
    expect(shoppingItemInputSchema.safeParse({ plannedOn: '2026-08-15', name: '' }).success).toBe(
      false
    );
  });

  it('空白だけの品名は弾く（trim してから長さを見る）', () => {
    expect(
      shoppingItemInputSchema.safeParse({ plannedOn: '2026-08-15', name: '   ' }).success
    ).toBe(false);
  });

  it('120字は通り、121字は弾く', () => {
    const ok = { plannedOn: '2026-08-15', name: 'あ'.repeat(120) };
    const ng = { plannedOn: '2026-08-15', name: 'あ'.repeat(121) };
    expect(shoppingItemInputSchema.safeParse(ok).success).toBe(true);
    expect(shoppingItemInputSchema.safeParse(ng).success).toBe(false);
  });

  it('日付の形が違えば弾く', () => {
    for (const plannedOn of ['2026-8-15', '20260815', '2026-08-15T00:00:00', '']) {
      expect(shoppingItemInputSchema.safeParse({ plannedOn, name: '牛乳' }).success).toBe(false);
    }
  });

  it('金額やカテゴリを送られても受け取らない（メモは台帳へ滲ませない）', () => {
    const r = shoppingItemInputSchema.parse({
      plannedOn: '2026-08-15',
      name: '牛乳',
      amount: 200,
      categoryId: 3,
    } as never);
    expect(r).toEqual({ plannedOn: '2026-08-15', name: '牛乳' });
  });
});

describe('shoppingItemPatchSchema', () => {
  it('チェックの真偽だけを受け取る', () => {
    expect(shoppingItemPatchSchema.parse({ isChecked: true })).toEqual({ isChecked: true });
    expect(shoppingItemPatchSchema.parse({ isChecked: false })).toEqual({ isChecked: false });
  });

  it('品名は直せない（送られても落とす）', () => {
    expect(shoppingItemPatchSchema.parse({ isChecked: true, name: '卵' } as never)).toEqual({
      isChecked: true,
    });
  });

  it('真偽以外は弾く。文字列の "true" も通さない', () => {
    expect(shoppingItemPatchSchema.safeParse({ isChecked: 'true' }).success).toBe(false);
    expect(shoppingItemPatchSchema.safeParse({}).success).toBe(false);
  });
});
