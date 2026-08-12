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

/** エラーがどの入力欄のものか。画面がその欄だけを赤くするために使う */
export type EntryField =
  | 'amount'
  | 'entryDate'
  | 'accountId'
  | 'counterAccountId'
  | 'budgetCategoryId'
  | 'poolId';

export interface NormalizeResult {
  ok: boolean;
  entry?: NormalizedEntry;
  error?: string;
  /**
   * どの欄が原因か。任意なので、文言だけ見る既存の呼び出し元はそのまま動く。
   * 一括登録は行が多く「何行目の何が」まで返さないと直せないため、ここで機械可読にしておく。
   */
  field?: EntryField;
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
      return {
        ok: false,
        error: '振替元と振替先の両方を選んでください',
        field: input.accountId ? 'counterAccountId' : 'accountId',
      };
    }
    if (input.accountId === input.counterAccountId) {
      return {
        ok: false,
        error: '振替元と振替先に同じ財布は選べません',
        field: 'counterAccountId',
      };
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
    return { ok: false, error: '支払い方法を選んでください', field: 'accountId' };
  }

  if (input.kind === 'income') {
    if (!input.budgetCategoryId) {
      return { ok: false, error: 'カテゴリを選んでください', field: 'budgetCategoryId' };
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
      field: 'budgetCategoryId',
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

// ---------------------------------------------------------------
// 一括登録
// ---------------------------------------------------------------

/**
 * 一括登録で扱う種別。振替は入れない。
 *
 * 振替は「移動元」と「移動先」の2口座が要るため、同じ列が行によって
 * カテゴリになったり移動先になったりする。表として読めなくなるので、
 * 振替は従来どおり1件ずつシートで記録する。
 */
export const BULK_ENTRY_KINDS = ['expense', 'income', 'refund'] as const;
export type BulkEntryKind = (typeof BULK_ENTRY_KINDS)[number];

/**
 * 1回で受け付ける行数の上限。
 *
 * 多値 INSERT のパラメータ数（11項目 × 50行 = 550）が mssql の上限 2100 に対して
 * 十分収まる範囲であり、Basic 5DTU で1トランザクションが長く居座らない量でもある。
 */
export const MAX_BULK_ROWS = 50;

/**
 * 一括登録の1行。
 *
 * 位置情報（lat / lng / locationAccuracy / placeName）は**受け取らない**。
 * まとめ打ちはレシートの束を後から入力する用途で、入力者はその店にいない。
 * 現在地を添えると支出マップと店名候補が無関係な座標で汚れる。
 * 画面が送ってきても、ここに項目が無いので落ちる。
 *
 * clientId も行では受けない。冪等性はバッチ全体にひとつ持たせる。
 */
export const bulkEntryRowSchema = entryInputSchema
  .omit({
    clientId: true,
    counterAccountId: true,
    lat: true,
    lng: true,
    locationAccuracy: true,
    placeName: true,
  })
  .extend({ kind: z.enum(BULK_ENTRY_KINDS) });

export type BulkEntryRow = z.infer<typeof bulkEntryRowSchema>;

export const bulkEntryInputSchema = z.object({
  /** バッチの受付番号。再送しても二重に登録しないために使う */
  clientId: z.string().uuid().nullable().optional(),
  rows: z
    .array(bulkEntryRowSchema)
    .min(1, '登録する行がありません')
    .max(MAX_BULK_ROWS, `一度に登録できるのは ${MAX_BULK_ROWS} 行までです`),
});

export type BulkEntryInput = z.infer<typeof bulkEntryInputSchema>;

/** 一括登録で行ごとに返す不備。画面はこの index で行を特定する */
export interface BulkRowIssue {
  /** 送られてきた rows の添字（0始まり） */
  index: number;
  /** どの欄か。特定できなければ null */
  field: string | null;
  message: string;
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
