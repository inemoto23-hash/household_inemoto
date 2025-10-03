# 家計簿システム

家族向けの家計簿管理Webアプリケーションです。PC・スマートフォンの両方からアクセス・操作が可能です。

## 機能

- **カレンダービュー**: 月別カレンダーで日別の取引を確認
- **取引入力**: 収入・支出・振替の記録
- **予算管理**: カテゴリ別月次予算の設定と管理
- **レシート解析**: OpenAI APIを使用した自動レシート解析
- **集計機能**: カテゴリ別・月別の収支集計
- **残高管理**: 財布・クレジットカード残高管理

## 技術スタック

- **フロントエンド**: HTML5, CSS3, JavaScript (Vanilla)
- **バックエンド**: Node.js, Express.js
- **データベース**: SQLite3
- **外部API**: OpenAI API (GPT-4 Vision)

## インストール

1. 依存関係のインストール:
```bash
npm install
```

2. 環境変数の設定:
```bash
cp .env.example .env
```

`.env`ファイルを編集してOpenAI APIキーを設定してください:
```
OPENAI_API_KEY=your_openai_api_key_here
PORT=3000
NODE_ENV=development
```

3. サーバーの起動:
```bash
# 開発モード
npm run dev

# 本番モード  
npm start
```

4. ブラウザでアクセス:
```
http://localhost:3000
```

## 使用方法

### 初期設定

1. **残高管理**タブで各財布の初期残高を設定
2. **予算管理**タブで月別予算を設定

### 日常的な使用

1. **カレンダー**から日付を選択
2. **入力**タブで取引を記録
3. **レシート解析**タブでレシート画像をアップロード（自動解析）
4. **集計**タブで月別収支を確認

## カテゴリ

### 出費カテゴリ
- 食費
- 生活費  
- 養育費
- ローン
- 小遣い
- 娯楽費
- 車維持費
- 医療費
- 公共料金
- 投資

### 財布カテゴリ
- 三井住友銀行
- 埼玉りそな銀行
- 楽天銀行
- 楽天証券
- 住信SBI証券
- 現金たけ
- 現金ささ
- Suicaたけ
- Suicaささ
- 楽天Payたけ
- 楽天Payささ

### クレジットカードカテゴリ
- 楽天カード
- PayPay

## データベース

SQLiteを使用してローカルに保存されます。データベースファイル: `database/budget.db`

## API仕様

### 取引関連
- `GET /api/transactions` - 取引一覧取得
- `POST /api/transactions` - 取引登録

### カテゴリ関連  
- `GET /api/expense-categories` - 出費カテゴリ一覧
- `GET /api/wallet-categories` - 財布カテゴリ一覧
- `GET /api/credit-categories` - クレジットカードカテゴリ一覧

### 予算管理
- `GET /api/budgets/:year/:month` - 予算取得
- `POST /api/budgets` - 予算設定

### レシート解析
- `POST /api/analyze-receipt` - レシート画像解析

### 集計
- `GET /api/summary/:year/:month` - 月別集計

### 残高管理
- `PUT /api/wallets/:id/balance` - 財布残高更新

## 注意事項

- OpenAI APIキーが必要です（レシート解析機能使用時）
- データはローカルのSQLiteに保存されます
- バックアップは定期的に取得することを推奨します

## ライセンス

ISC License