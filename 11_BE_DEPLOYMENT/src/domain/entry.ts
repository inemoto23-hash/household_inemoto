/**
 * 取引の入力検証と正規化。
 *
 * ここは純粋関数だけで構成する。DB にも HTTP にも触れないので単体テストしやすい。
 * 現行アプリのバグ（種別を変えると前の種別の値が残る）は、
 * この normalize が種別ごとに不要項目を必ず NULL にすることで構造的に防ぐ。
 * 最終防衛線は DB の ck_entries_shape 制約。
 */
import { z } from 'zod';

export const ENTRY_KINDS = ['expense', 'income', 'transfer', 'refund'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** 予算カテゴリを持つ種別。transfer だけが持たない */
export function usesBudgetCategory(kind: EntryKind): boolean {
  return kind !== 'transfer';
}

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD 形式で指定してください');

export const entryInputSchema = z.object({
  entryDate: dateString,
  kind: z.enum(ENTRY_KINDS),
  amount: z.coerce.number().int().positive('金額は1円以上で入力してください'),
  budgetCategoryId: z.coerce.number().int().positive().nullable().optional(),
  accountId: z.coerce.number().int().positive().nullable().optional(),
  counterAccountId: z.coerce.number().int().positive().nullable().optional(),
  poolId: z.coerce.number().int().positive().nullable().optional(),
  merchant: z.string().trim().max(120).nullable().optional(),
  memo: z.string().trim().max(500).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  // 位置情報。取れなくても登録は成立するので、すべて任意
  lat: z.coerce.number().min(-90).max(90).nullable().optional(),
  lng: z.coerce.number().min(-180).max(180).nullable().optional(),
  locationAccuracy: z.coerce.number().int().min(0).nullable().optional(),
  placeName: z.string().trim().max(120).nullable().optional(),
});

export type EntryInput = z.infer<typeof entryInputSchema>;

/** 種別に応じて実際に保存する値。使わない項目は必ず null になる */
export interface NormalizedEntry {
  entryDate: string;
  kind: EntryKind;
  amount: number;
  budgetCategoryId: number | null;
  accountId: number | null;
  counterAccountId: number | null;
  poolId: number | null;
  merchant: string | null;
  memo: string | null;
}

export interface NormalizeResult {
  ok: boolean;
  entry?: NormalizedEntry;
  error?: string;
}

/**
 * 種別ごとに項目を整える。
 * 画面から前の種別の値が残ったまま送られてきても、ここで確実に落とす。
 */
export function normalizeEntry(input: EntryInput): NormalizeResult {
  const base = {
    entryDate: input.entryDate,
    kind: input.kind,
    amount: input.amount,
    merchant: input.merchant?.trim() || null,
    memo: input.memo?.trim() || null,
  };

  if (input.kind === 'transfer') {
    if (!input.accountId || !input.counterAccountId) {
      return { ok: false, error: '振替元と振替先の両方を選んでください' };
    }
    if (input.accountId === input.counterAccountId) {
      return { ok: false, error: '振替元と振替先に同じ財布は選べません' };
    }
    return {
      ok: true,
      entry: {
        ...base,
        // 振替は予算に影響しない。カテゴリもプールも持たせない
        budgetCategoryId: null,
        accountId: input.accountId,
        counterAccountId: input.counterAccountId,
        poolId: null,
      },
    };
  }

  // 実際のお金は必ず財布かクレジットから動く
  if (!input.accountId) {
    return { ok: false, error: '支払い方法を選んでください' };
  }

  if (input.kind === 'income') {
    if (!input.budgetCategoryId) {
      return { ok: false, error: 'カテゴリを選んでください' };
    }
    return {
      ok: true,
      entry: {
        ...base,
        budgetCategoryId: input.budgetCategoryId,
        accountId: input.accountId,
        counterAccountId: null,
        poolId: null,
      },
    };
  }

  // expense / refund — 負担先は「予算カテゴリ」か「プール」のどちらか一方。
  // プールは予算世界の貯金箱なので、そこから出す支出は予算カテゴリを消費しない。
  const hasCategory = !!input.budgetCategoryId;
  const hasPool = !!input.poolId;

  if (hasCategory === hasPool) {
    return {
      ok: false,
      error: hasCategory
        ? 'カテゴリとプールは同時に選べません。どちらか一方にしてください'
        : 'カテゴリかプールのどちらかを選んでください',
    };
  }

  return {
    ok: true,
    entry: {
      ...base,
      budgetCategoryId: hasCategory ? input.budgetCategoryId! : null,
      accountId: input.accountId,
      counterAccountId: null,
      poolId: hasPool ? input.poolId! : null,
    },
  };
}

/** 'YYYY-MM' を検証して、その月の開始日と翌月開始日を返す */
export function monthRange(yearMonth: string): { from: string; toExclusive: string } | null {
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) return null;
  const [y, m] = yearMonth.split('-').map(Number);
  if (m < 1 || m > 12) return null;

  const pad = (n: number) => String(n).padStart(2, '0');
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;

  return { from: `${y}-${pad(m)}-01`, toExclusive: `${nextY}-${pad(nextM)}-01` };
}
