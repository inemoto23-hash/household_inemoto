/**
 * ゼロサムで動かす金額の対。
 *
 * ここは純粋関数だけで構成する。DB にも HTTP にも触れない。
 *
 * 「同じ transfer_group_id で ±N の2行を書き、合計は常に 0」という決まりは
 * 予算の組み換え・プールの出し入れ・締めのプール移送の3箇所で共有している。
 * 符号を各所で組み立てると、どこか1箇所だけ逆になる事故が起こせてしまう。
 * 対をここでしか作れない形にして、事故を構造で防ぐ。
 *
 * どちらの台帳が「出る側」かは呼び出し元が決める:
 * - 組み換え:         移動元カテゴリが out、移動先カテゴリが in
 * - プールへ積む:     予算が out、プールが in
 * - プールから出す:   プールが out、予算が in
 * - 締めのプール移送: 予算が out、プールが in
 */

export interface TransferPair {
  groupId: string;
  /** 出る側に書く金額。必ず負 */
  outAmount: number;
  /** 入る側に書く金額。必ず正 */
  inAmount: number;
}

/**
 * ±N の対を作る。outAmount + inAmount は定義上必ず 0 になる。
 * groupId の生成（randomUUID）は副作用なので呼び出し元が渡す。
 */
export function buildTransferPair(amount: number, groupId: string): TransferPair {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`対で動かす金額は正の整数で指定してください: ${amount}`);
  }
  return { groupId, outAmount: -amount, inAmount: amount };
}
