# Railwayデプロイ手順

## 前提条件
- Railwayアカウント（https://railway.app）
- GitHubアカウント

## 手順

### 1. GitHubリポジトリ作成

1. https://github.com/new にアクセス
2. リポジトリ名を入力（例: `household-budget-app`）
3. **Private** で作成
4. **「Initialize this repository with a README」のチェックは外す**

### 2. GitHubにプッシュ

```bash
cd "C:\Users\inemo\Desktop\家計簿アプリ"

# リモートリポジトリを追加（YOUR_USERNAMEを自分のユーザー名に変更）
git remote add origin https://github.com/YOUR_USERNAME/household-budget-app.git

# ブランチ名をmainに変更
git branch -M main

# プッシュ
git push -u origin main
```

### 3. Railwayでデプロイ

#### 3-1. 新規プロジェクト作成
1. https://railway.app にアクセス
2. 「New Project」をクリック
3. 「Deploy from GitHub repo」を選択
4. 作成したリポジトリを選択

#### 3-2. PostgreSQLデータベース追加
1. プロジェクト画面で「New」→「Database」→「Add PostgreSQL」
2. データベースが自動的に作成される
3. `DATABASE_URL` 環境変数が自動的にアプリに接続される

#### 3-3. 環境変数設定
1. アプリのサービスをクリック
2. 「Variables」タブを開く
3. 以下を追加：

```
OPENAI_API_KEY=your-openai-api-key
NODE_ENV=production
```

**注意**: `DATABASE_URL` は自動設定されるので追加不要

#### 3-4. ドメイン設定
1. アプリのサービスをクリック
2. 「Settings」タブを開く
3. 「Networking」→「Generate Domain」
4. 生成されたURLでアクセス可能

### 4. デプロイ完了

- 自動的にビルド＆デプロイが開始されます
- 「Deployments」タブでログを確認できます
- エラーがなければ、生成されたURLにアクセス！

## トラブルシューティング

### ビルドエラーが出る場合
- 「Deployments」タブのログを確認
- 環境変数が正しく設定されているか確認

### データベース接続エラーが出る場合
- PostgreSQLが追加されているか確認
- `DATABASE_URL` が設定されているか確認（Variables タブ）

### デプロイ後に変更を反映したい場合
```bash
git add .
git commit -m "Update: 変更内容"
git push
```
自動的に再デプロイされます。

## コスト
- 月$5の無料クレジット付き
- PostgreSQL: 約$5/月（500MBまで）
- アプリ: 使用量に応じて課金

## 参考リンク
- Railway公式ドキュメント: https://docs.railway.app
- PostgreSQL接続情報: Databaseサービスの「Connect」タブで確認
