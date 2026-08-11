# 20260811 アップデート予定（定期取引の登録）

- **計画書**: `C:\Users\inemo\.claude\plans\precious-giggling-balloon.md`（承認済み）
- **ユーザー手動手順**: なし。Azure 側の新規リソース作成・権限付与は発生しない

## やること

家賃・サブスクのように毎月同じ記録を、一度入れたら以降は自動で作られるようにする。

| 対象 | 内容 |
|---|---|
| DB | `011_recurring.sql` — `recurring_rules` 新設、`entries.recurring_rule_id` 追加 |
| BE | `domain/recurrence.ts`（日付計算）、`functions/recurring.ts`（CRUD）、`functions/recurringSweep.ts`（日次タイマー） |
| FE | `features/recurring/RecurrenceFields.tsx`、`EntryForm` に「定期取引にする」、設定に「定期」タブ |
| 文書 | `system_architecture.md` / `system_flow.md` / `91_UPDATE/21/` |

## 決めたこと

- 予約日が来たら**自動で記帳する**。レコードストックには入れない
- **未来の行は作らない。** 先に入れると未払いのお金で残高が減る
- カレンダーへの先出し表示はしない。次回予定は設定の定期タブで見る
- 対象種別は支出・収入・振替（カード引落含む）

## 注意する点

- 二重記帳は `(recurring_rule_id, entry_date)` の一意インデックスで DB が止める
- 長く止めたルールを再開したときに過去分が湧かないよう、**62日より古い予定は読み飛ばす**
- タイマーは JST 00:10（UTC 15:10）。既存の `reminderSweep` と合わせて2本になる
