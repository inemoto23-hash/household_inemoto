# 家計簿アプリ開発セッション - 並び順DB管理への移行

## 概要
このセッションでは、カテゴリと予算の並び順管理をlocalStorageからデータベース管理に移行しました。これにより、スマホ・PC間で並び順が統一されるようになりました。

## 実施した変更

### 1. localStorage依存の完全削除
**ファイル**: `public/js/app.js`

- `loadItemOrder()` 関数を削除
- `getStorageKeyForContainer()` 関数を削除
- `getItemKey()` 関数を削除
- すべての `loadItemOrder()` 呼び出しを削除し、APIから取得したデータをそのまま使用

**変更箇所**:
```javascript
// 修正前
const sortedExpenseCategories = loadItemOrder('#expense-category', expenseCategories, 'category.name');

// 修正後
const sortedExpenseCategories = expenseCategories;
```

### 2. サマリーデータの並び順修正
**ファイル**: `server.js`

支出サマリーとクレジットサマリーのクエリで `ORDER BY order_index, name` を使用:

```javascript
// 支出サマリー (line 1323-1324)
GROUP BY ec.id, ec.name, ec.order_index, mb.budget_amount
ORDER BY ec.order_index, ec.name

// クレジットサマリー (line 1334)
ORDER BY cc.order_index, cc.name
```

### 3. サマリー要素へのID追加
**ファイル**: `public/js/app.js`

ドラッグ&ドロップ時にIDを取得できるよう、data属性を追加:

```javascript
// 支出サマリー (line 1315)
summaryItem.dataset.categoryId = item.expense_category_id;

// クレジットサマリー (line 1392)
summaryItem.dataset.creditId = item.category_id;
```

### 4. 予算設定ページのカテゴリ再取得
**ファイル**: `public/js/app.js`

`loadBudget()` 関数で、毎回カテゴリを再取得して最新の並び順を反映:

```javascript
// 予算読み込み (line 1158-1160)
const categoriesResponse = await fetch('/api/expense-categories');
const categories = await categoriesResponse.json();
const sortedCategories = categories;
```

### 5. デバッグログの追加

**クライアント側** (`public/js/app.js` line 1547):
```javascript
console.log(`${containerId}[${index}]: categoryId=${categoryId}, id=${parseInt(categoryId)}`);
```

**サーバー側** (`server.js` line 1630, 1653):
```javascript
console.log('並び順更新リクエスト:', { type, items });
console.log(`UPDATE ${tableName} SET order_index=${item.order_index} WHERE id=${item.id}`);
```

## データベーススキーマ

すべてのカテゴリテーブルに `order_index` カラムが追加されています:

```sql
CREATE TABLE expense_categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    order_index INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE wallet_categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    balance DECIMAL(10,2) DEFAULT 0,
    order_index INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE credit_categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    order_index INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## API エンドポイント

### POST /api/update-order
並び順を更新するエンドポイント

**リクエストボディ**:
```json
{
  "type": "expense" | "wallet" | "credit",
  "items": [
    { "id": 1, "order_index": 0 },
    { "id": 2, "order_index": 1 }
  ]
}
```

**実装** (`server.js` line 1627-1665)

## 並び順保存の流れ

1. ユーザーがドラッグ&ドロップで並び順を変更
2. `handleDrop()` イベントで DOM を更新
3. `saveItemOrder()` 関数が呼ばれる
4. 要素から `data-*` 属性を取得してIDリストを構築
5. `/api/update-order` に POST リクエスト
6. サーバーが `order_index` カラムを更新
7. 次回データ取得時に `ORDER BY order_index, name` で並び順が反映される

## 問題と解決策

### 問題1: スマホとPCで並び順が異なる
**原因**: `loadItemOrder()` が localStorage から端末固有の並び順を読み込んでいた

**解決**: localStorage 依存を完全削除し、データベースの `order_index` のみを使用

### 問題2: 手動で並び順を直しても元に戻る
**原因1**: サマリークエリが `ORDER BY name` のみでソートしていた

**解決1**: `ORDER BY order_index, name` に変更

**原因2**: 予算設定ページがグローバル変数 `expenseCategories` を使用（初期化時のみ取得）

**解決2**: `loadBudget()` で毎回カテゴリを再取得

### 問題3: サマリーの並び順が保存されない
**原因**: 要素に `data-category-id` / `data-credit-id` が設定されていなかった

**解決**: `summaryItem.dataset.categoryId` と `summaryItem.dataset.creditId` を追加

## コミット履歴

1. `localStorage依存を完全に削除してDB管理に統一` (919ecbb)
2. `サマリーの並び順をorder_index基準に修正` (f34a82b)
3. `予算設定ページでカテゴリを再取得して並び順を反映` (22e65f0)

## テスト方法

1. **予算設定ページ**:
   - 予算設定ページでカテゴリの並び順を変更
   - 「予算読み込み」ボタンをクリック
   - 並び順が保持されていることを確認

2. **確認ページ（サマリー）**:
   - 支出サマリー・クレジットサマリーの並び順を変更
   - ページをリロード
   - 並び順が保持されていることを確認

3. **クロスデバイス**:
   - PCで並び順を変更
   - スマホでアクセス
   - 同じ並び順で表示されることを確認

## デバッグ方法

### ブラウザコンソール
並び順変更時に以下のログが出力されます:
```
budget-list[0]: categoryId=5, id=5
budget-list[1]: categoryId=3, id=3
順序をDBに保存しました (budget-list): [{id: 5, order_index: 0}, {id: 3, order_index: 1}]
```

### サーバーログ
```
並び順更新リクエスト: { type: 'expense', items: [{id: 5, order_index: 0}, {id: 3, order_index: 1}] }
UPDATE expense_categories SET order_index=0 WHERE id=5
UPDATE expense_categories SET order_index=1 WHERE id=3
```

## 関連ファイル

- `database/database.js` - order_index カラムのマイグレーション
- `server.js` - カテゴリ取得・並び順更新API
- `public/js/app.js` - フロントエンド並び順処理
- `public/index.html` - ドラッグ&ドロップUI

## 次のステップ（必要に応じて）

- [ ] デバッグログを本番環境では削除
- [ ] 並び順のアニメーション改善
- [ ] エラーハンドリングの強化
- [ ] 並び順変更時の保存中インジケーター表示
