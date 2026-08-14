/**
 * 買い物メモの入力検証。
 *
 * ここは純粋関数だけで構成する。DB にも HTTP にも触れない形にしておき、
 * 「空白だけの品名が入る」「日付の形が違う」といった入口の抜けを
 * 単体で確かめられるようにする。
 *
 * 持たせるのは品名とチェックだけ。想定金額・カテゴリ・担当者は入れない。
 * 品目ごとに金額を持たせると、未実装の「明細分割」を先取りすることになり、
 * メモが台帳へ滲む（90_DOCUMENT/10_計画/03_機能候補.md §6）。
 */
import { z } from 'zod';

export const MAX_ITEM_NAME = 120;

/** 追加。日付は画面が選んでいる日そのもの */
export const shoppingItemInputSchema = z.object({
  plannedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD 形式で指定してください'),
  // trim を先に通すので、空白だけの品名は min(1) で落ちる。
  // DB 側の ck_shop_name も同じことを見ている（画面の作りには依存させない）
  name: z.string().trim().min(1, '品名を入力してください').max(MAX_ITEM_NAME),
});

export type ShoppingItemInput = z.infer<typeof shoppingItemInputSchema>;

/**
 * 更新はチェックの切り替えだけ。品名は直せない。
 * 打ち間違いは消して足し直すほうが速く、編集の導線を足すと
 * 「行を押す＝チェック」という一番よく使う操作と取り合いになる。
 */
export const shoppingItemPatchSchema = z.object({
  isChecked: z.boolean(),
});

export type ShoppingItemPatch = z.infer<typeof shoppingItemPatchSchema>;
