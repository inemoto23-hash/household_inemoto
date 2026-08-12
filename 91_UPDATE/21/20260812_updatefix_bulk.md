# 20260812 アップデート完了記録（リストからの一括登録）

- **予定書**: `91_UPDATE/11/20260812_update_bulk.md`
- **計画書**: `91_UPDATE/01/20260812_01_plan.md`
- **ユーザー手動手順**: なし（DB マイグレーションも不要）

## やったこと

記帳の導線が「日付を選ぶ → 1件入力 → 保存」しかなく、レシートの束やカード明細を
まとめて打つときに同じ日付・同じ口座を何度も選び直していた。
行を並べて一度に登録する `/bulk` を追加した。

1行の項目は **種別（既定=支出）/ 金額 / 日付 / カテゴリ / 口座 / 店先・支払名**。

## データベース

**変更なし。** 既存の `entries` にそのまま追記する。
`ck_entries_shape` も `ux_entries_client_id` も、そのまま効かせている。

## バックエンド

`POST /api/entries/bulk`（関数名 `entriesBulkCreate`）を追加。

| ファイル | 内容 |
|---|---|
| `domain/entry.ts` | `BULK_ENTRY_KINDS` / `bulkEntryRowSchema` / `bulkEntryInputSchema` / `MAX_BULK_ROWS` / `BulkRowIssue`。`NormalizeResult` に任意の `field` を追加 |
| `functions/entriesBulk.ts`（新規） | 一括登録の本体。`findMissingReferences` と多値 INSERT |
| `functions/entries.ts` | `assertReferencesInHousehold` に「単件用」と相互参照のコメント |
| `index.ts` | import 追加 |

`entries.ts` は既に507行あるので追記せず別ファイルにした。
`entries/{id}` は PATCH/DELETE のみなので `entries/bulk` の POST とルートは衝突しない。

### 判断したこと

**「全か無か」は、検証を書き込みの前に終わらせることで作る。**

```
zod → 全行 normalizeEntry（1件目で止めず全部集める）
    → 参照ID の一括検証（往復1回）
    → 不備が1件でもあれば 400。ここまでトランザクションを開かない
    → begin → clientId 重複チェック → 多値 INSERT → commit
```

通常の不備では1行も INSERT されない。万一 DB 制約（`ck_entries_shape` / FK）が
発火しても1トランザクションなので `rollback` で全部戻る。
「途中まで入って、どこまで入ったか分からない」状態が構造的に起きない。

**行数が増えても往復を増やさない。** 既存の `assertReferencesInHousehold` は
1件につき最大3往復するため、50行だと150往復になる。Basic 5DTU では持たない。
`findMissingReferences` は ID の集合を作り、SELECT を3本セミコロンで並べて
`recordsets` で受ける（`calendarMonth` と同じ書き方）。**往復1回**で済む。
INSERT も多値 VALUES の1文にまとめた（11項目 × 50行 = 550 パラメータ。上限2100に余裕）。

既存の単件版は**残した**。`entriesCreate` / `entriesUpdate` はそちらのほうが読みやすい。
両方に相互参照のコメントを置いてある。

**種別は支出・収入・返金のみ。** 振替は移動元と移動先の2口座が要るため、
「カテゴリ」の列が行によって「移動先」に変わる。表として読めなくなるので入口の
`z.enum` で弾く。振替は従来どおり1件ずつシートで記録する。

**位置情報は受け取らない。** `bulkEntryRowSchema` に `lat` / `lng` /
`locationAccuracy` / `placeName` の項目を置いていない。
まとめ打ちはレシートの束を後から入力する用途で、入力者はその店にいない。
`stripIfAtHome` は「自宅なら捨てる」だけなので、**外出先で打つと全行に無関係な座標が残る**。
入口で受け取らなければ、画面が送ってきても落ちる。
副次的に households の SELECT が1往復減る。

**`source` は `'manual'` のまま。** `ck_entries_source` に `'bulk'` を足すには
migration が要るうえ、一括も人が手で打ったもので由来は同じ。
「まとめて入れた分だけ後から見たい」が出てから足せばよい。

**冪等性はバッチ全体に UUID をひとつ。行ごとではない。**
`ux_entries_client_id` は `(household_id, client_id)` の部分一意索引なので、
全行に同じ値を入れると2行目で必ず違反する。**先頭行にだけ**刻む
（＝この値はバッチの受付番号であって、行の識別子ではない）。
トランザクション内で1回だけ存在を引き、あれば何も書かず `duplicated: true` を返す。
同時押しで擦り抜けても、索引違反（2601 / 2627）を 409 `DUPLICATE_BATCH` に変える。

**締め済み月とプール残高のチェックはしない。** 既存の `entriesCreate` がしていないため。
ここだけ厳しくすると経路によって挙動が割れる。

### エラーの形

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "2 件の行に不備があります",
  "details": { "rows": [
    { "index": 0, "field": "amount", "message": "金額は1円以上で入力してください" },
    { "index": 3, "field": "accountId", "message": "指定された財布が見つかりません" } ] } } }
```

`index` は送った `rows` の0始まり添字。`message` は日本語のままにし、
画面側にコード→文言の対応表を持たせない。
`NormalizeResult.field` を**任意**で足したので、既存の呼び出し元2箇所は無変更で通る。

同じ不正な ID を複数行が使っていれば、その行すべてに印を付ける。

## フロントエンド

| ファイル | 内容 |
|---|---|
| `features/entries/bulk/BulkEntryPage.tsx`（新規） | 画面本体。行の配列・送信・エラーの行への紐付け |
| `features/entries/bulk/BulkRowFields.tsx`（新規） | 1行分の入力。PC / スマホ共通の DOM |
| `features/entries/bulk/bulkRow.ts`（新規） | `BulkRow` 型と純粋関数 |
| `features/entries/pickOptions.ts`（新規） | 選択肢の作り方。`EntryForm` から移設 |
| `components/PickCell.tsx`（新規） | 表のセル用の選択欄 |
| `components/PickField.tsx` | 中のリストを `PickList` として切り出して export |
| `features/entries/EntryForm.tsx` | 移設に伴う import 差し替えのみ |
| `features/accounts/AccountsPage.tsx` | `accountLabel` の import 元を変更 |
| `features/calendar/CalendarPage.tsx` | 「📋 まとめて」を追加、ボタン列を折り返し可に |
| `App.tsx` / `styles/tokens.css` | `/bulk` ルート、`.bulk-*` |

### 判断したこと

**負担先はひとつの文字列（`chargeKey`）で持つ。** `EntryForm` は
`chargeTo` + `budgetCategoryId` + `poolId` の3つで表しているが、一括では
`'c:12'`（予算カテゴリ）/ `'p:3'`（プール）の**1文字列**にした。
「カテゴリとプールの両方が入っている」状態を**構造的に作れない**。
選択肢を作る `chargeGroups` が収入のときプール群を出さないので、排他の決まりが
選択肢の作り方そのものになっている。

**`EntryFormValue` は使い回さない。** あちらは振替（`payVia` / `transferMode` /
`counterAccountId`）と定期取引（`recurrence`）を抱えていて、一括では出番がない。
ダミーを詰めて `toPayload` を呼ぶと「なぜ振替の値が要るのか」で読み手が止まる。
**共通の真実はサーバーへ送る JSON の形だけ**にし、状態型は画面ごとに持つ。
この線引きは `bulkRow.ts` の冒頭に書いてある。

**選択肢の作り方は共通化した。** `accountGroups` / `categoryItem` は
`EntryForm.tsx` の非 export だった。口座の並べ方（優先表示 → 種別ごと）と
クレジットの見せ方（マイナス残高を「支払」として正で出す）が2箇所に分かれると、
いずれ片方だけ直る。`pickOptions.ts` を唯一の出どころにした。
**振る舞いは変えていない**（移設のみ）。

**`PickField` は中のリストを切り出しただけ。** 既存6画面が使う部品なので、
DOM も寸法も色も据え置きにして `PickList` として export し、`PickField` 自身は
それを呼ぶ形に置き換えた。`PickCell` から同じ並びを使うため。

**セル用の選択欄を新設した。** `PickField` は見出しが必ず縦に付き、
**開くとその場で下へ伸びる**ため、表のセルに置くと行の高さが変わって下の行が
押し下げられる。`PickCell` は見出しを持たず 40px で、押すと既存の `Sheet` を開く。
見出しが無い代わりに `aria-label` に「3行目のカテゴリ」を入れて読み上げを成立させた。

**PC の表とスマホのカードは DOM ひとつで書き分ける。** `.bulk-*` が
レイアウトだけを切り替える。区切りはシートと同じ 900px。
画面幅ごとに別の JSX を書くと、片方だけ直る欄が必ず出る。

760px のシェルに7列を収めるのは窮屈なので、実測しながら詰めた
（`22px 74px 76px 118px 1fr 1fr 1.15fr 44px` / gap 6px）。
種別の選択欄は三角、日付欄はカレンダーの絵の分だけ幅を食うため、
その2つは左右の余白を詰めてある。360 / 768 / 1280px で横スクロールは出ない。

**行の「追加」と「複製」は役割を分けた。**

| 操作 | 引き継ぐもの | 使う場面 |
|---|---|---|
| ＋ 行を追加 | 日付・口座・種別 | 同じ日のレシート。カテゴリと金額は毎回変わる |
| ⧉ 複製 | 全部 | 同じ店で金額違いを続けて打つ |

**空の行は黙って捨てない。** 送信対象から自動で外すが、
「空の行 n 件は登録しません」と必ず書く。打ったつもりの行が消えたように見えるのを防ぐ。

**押せない理由を書く。** 「あと2行に不備があります」を送信ボタンの横に出す。
無効なボタンだけ置くと手が止まる。

**送った行そのものを mutate の引数にする。** 画面の state を `onError` から
見にいくと、送信中に行を触られたときにサーバーの `index` と行の対応がずれる。
`sent[issue.index].key` で紐付けるので、ずれようがない。

**直した瞬間に指摘を消す。** その行を編集したら、サーバーが返した赤字を落とす。
直ったのに赤いままだと、直ったかどうかが分からない。

**`details` が想定の形でないときは上部の `ErrorText` に落とす。**
500・通信断・古いデプロイでも画面が壊れない道を必ず残す。

**再送で受付済みだった場合は文言を分ける。** `duplicated` なら
「すでに登録済みでした。二重には入っていません」と出す。
「0 件を登録しました」だと失敗したように見える。

**行の React key は採番した文字列。** 配列の添字を key にすると、
途中の行を消したときに入力中の値が1つ下の行へずれて見える。

## 確認したこと

- `11_BE_DEPLOYMENT`: `npm run build`（tsc）が通る
- `10_SITE_DEPLOYMENT`: `npm run typecheck` / `npm run build` が通る
- `bulkEntryInputSchema` / `normalizeEntry` の単体確認（11項目、すべて期待どおり）
  - 振替を受け付けない / 位置情報が残らない / 0行と51行を弾く / 50行は通る
  - zod の path から行番号と項目名が取れる
  - カテゴリとプールの同時指定を弾く / プール支出はカテゴリが null / 収入はプールを落とす
- 画面の描画を 360 / 768 / 1280px で確認（横スクロールなし、コンソールエラーなし）
- カテゴリ欄が支出ではプール群を出し、収入では出さないこと。
  種別を変えると選択済みの負担先が外れること

**未確認**: 実際の DB を相手にした通しの動作（`func start` はマネージドIDでの
Azure SQL 接続が要るためローカルでは動かない）。デプロイ後に下記を確認すること。

1. n 行を登録 → カレンダーの日別金額・`/accounts` の残高・`/budget` の残りが n 行分だけ動く
2. DevTools で別世帯のカテゴリ ID を送り込む → **何も登録されず**行番号付きのエラーが返る
3. 送信ボタン連打／送信直後のリロードで再送 → 二重登録されない
4. 直近の行で `source='manual'`、`lat`/`lng`/`location_accuracy`/`place_name` が
   すべて NULL、`counter_account_id` が NULL、`client_id` が先頭行にだけ入っている

## 残課題

| 項目 | 状態 |
|---|---|
| L2 ドキュメント（`90_DOCUMENT/01_開発ドキュメント/`） | 未着手 |
| `refreshLedger()` の切り出し（`CalendarPage` / `StockPage` の invalidate キーのばらつき） | 後回し |
| localStorage への下書き保存（送信中に切れると入力が宙に浮く） | 後回し。いつ消すかの設計が要る |
| `ck_entries_source` に `'bulk'` を足す migration | 必要になってから |
| 一括で入れたものは支出マップに出ず、店名候補の学習にも効かない | 位置情報を持たせない判断の帰結。仕様 |
