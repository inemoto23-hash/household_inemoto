require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const db = require('./database/database');
const { seedDatabase } = require('./database/seed');

const app = express();
const PORT = process.env.PORT || 3000;

// データベース初期化の確認と実行
async function initializeDatabase() {
    try {
        // データベースに接続
        await db.connect();
        
        // PostgreSQLの場合は情報スキーマ、SQLiteの場合はsqlite_masterを使用
        let tableCheck;
        if (db.type === 'postgresql') {
            tableCheck = await db.get("SELECT table_name FROM information_schema.tables WHERE table_name = 'transactions'");
        } else {
            tableCheck = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'");
        }
        
        if (!tableCheck) {
            console.log('データベースが未初期化です。初期化を実行します...');
            await seedDatabase(db);
        } else {
            // データが存在するかチェック
            const dataCheck = await db.get('SELECT COUNT(*) as count FROM transactions');
            if (dataCheck.count === 0) {
                console.log('データベースにデータが存在しません。シードデータを投入します...');
                await seedDatabase(db);
            } else {
                console.log(`データベース初期化済み: ${dataCheck.count}件の取引データが存在します`);
            }
        }
    } catch (error) {
        console.error('データベース初期化エラー:', error);
        // 初期化に失敗してもサーバーは開始する
    }
}

// サーバー起動時にデータベースを初期化
initializeDatabase();

// バックアップ関連API

// データベース状態確認API
app.get('/api/database/status', async (req, res) => {
    try {
        res.json({
            type: db.type || 'unknown',
            connected: !!db.client,
            environment: process.env.NODE_ENV || 'development',
            hasDatabaseUrl: !!process.env.DATABASE_URL,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('データベース状態確認エラー:', error);
        res.status(500).json({ 
            error: 'データベース状態の確認に失敗しました',
            type: 'unknown',
            connected: false
        });
    }
});

// データベース全体をSQL形式でエクスポート
app.get('/api/backup/sql', async (req, res) => {
    try {
        console.log('SQLバックアップ開始');
        
        // 現在の日時をファイル名に使用
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `household-budget-backup-${timestamp}.sql`;
        
        let sqlContent = '-- データベースバックアップ SQL\\n';
        sqlContent += `-- 作成日時: ${now.toLocaleString('ja-JP')}\\n\\n`;
        
        // テーブル一覧を取得
        let tables;
        if (db.type === 'postgresql') {
            const result = await db.all("SELECT table_name as name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
            tables = result;
        } else {
            tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
        }
        
        for (const table of tables) {
            const tableName = table.name;
            sqlContent += `-- ${tableName} データ\\n`;
            
            const rows = await db.all(`SELECT * FROM ${tableName}`);
            
            for (const row of rows) {
                const columns = Object.keys(row).join(', ');
                const values = Object.values(row).map(val => {
                    if (val === null) return 'NULL';
                    if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
                    return val;
                }).join(', ');
                
                sqlContent += `INSERT INTO ${tableName} (${columns}) VALUES (${values});\\n`;
            }
            sqlContent += '\\n';
        }
        
        // ファイルとしてダウンロード
        res.setHeader('Content-Type', 'application/sql');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(sqlContent);
        
        console.log(`SQLバックアップ完了: ${filename}`);
    } catch (error) {
        console.error('SQLバックアップエラー:', error);
        res.status(500).json({ error: 'バックアップの作成に失敗しました' });
    }
});

// データベース全体をJSON形式でエクスポート
app.get('/api/backup/json', async (req, res) => {
    try {
        console.log('JSONバックアップ開始');
        
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `household-budget-backup-${timestamp}.json`;
        
        const backup = {
            timestamp: now.toISOString(),
            version: '1.0',
            tables: {}
        };
        
        // 全テーブルのデータを取得
        let tables;
        if (db.type === 'postgresql') {
            const result = await db.all("SELECT table_name as name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
            tables = result;
        } else {
            tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
        }
        
        for (const table of tables) {
            const tableName = table.name;
            backup.tables[tableName] = await db.all(`SELECT * FROM ${tableName}`);
        }
        
        // ファイルとしてダウンロード
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json(backup);
        
        console.log(`JSONバックアップ完了: ${filename} (${Object.keys(backup.tables).length}テーブル)`);
    } catch (error) {
        console.error('JSONバックアップエラー:', error);
        res.status(500).json({ error: 'バックアップの作成に失敗しました' });
    }
});

// ミドルウェア
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ファイルアップロード設定
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// API Routes

// カテゴリ取得API
app.get('/api/expense-categories', async (req, res) => {
    try {
        const categories = await db.all('SELECT * FROM expense_categories ORDER BY name');
        res.json(categories);
    } catch (error) {
        res.status(500).json({ error: 'カテゴリの取得に失敗しました' });
    }
});

app.get('/api/wallet-categories', async (req, res) => {
    try {
        const wallets = await db.all('SELECT * FROM wallet_categories ORDER BY name');
        res.json(wallets);
    } catch (error) {
        res.status(500).json({ error: '財布カテゴリの取得に失敗しました' });
    }
});

app.get('/api/credit-categories', async (req, res) => {
    try {
        const credits = await db.all('SELECT * FROM credit_categories ORDER BY name');
        res.json(credits);
    } catch (error) {
        res.status(500).json({ error: 'クレジットカードカテゴリの取得に失敗しました' });
    }
});

// 出費カテゴリ追加API
app.post('/api/expense-categories', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'カテゴリ名が必要です' });
        }
        
        const result = await db.run('INSERT INTO expense_categories (name) VALUES (?)', [name]);
        res.json({ id: result.lastID, name, message: '出費カテゴリを追加しました' });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            res.status(400).json({ error: '同じ名前のカテゴリが既に存在します' });
        } else {
            console.error('出費カテゴリ追加エラー:', error);
            res.status(500).json({ error: '出費カテゴリの追加に失敗しました' });
        }
    }
});

// 出費カテゴリ削除API
app.delete('/api/expense-categories/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // そのカテゴリが使用されている取引がないかチェック
        const usageCheck = await db.get('SELECT COUNT(*) as count FROM transactions WHERE expense_category_id = ?', [id]);
        if (usageCheck.count > 0) {
            return res.status(400).json({ error: 'このカテゴリは取引で使用されているため削除できません' });
        }
        
        // 予算設定もチェック
        const budgetCheck = await db.get('SELECT COUNT(*) as count FROM monthly_budgets WHERE expense_category_id = ?', [id]);
        if (budgetCheck.count > 0) {
            return res.status(400).json({ error: 'このカテゴリは予算設定で使用されているため削除できません' });
        }
        
        const result = await db.run('DELETE FROM expense_categories WHERE id = ?', [id]);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'カテゴリが見つかりません' });
        }
        
        res.json({ message: '出費カテゴリを削除しました' });
    } catch (error) {
        console.error('出費カテゴリ削除エラー:', error);
        res.status(500).json({ error: '出費カテゴリの削除に失敗しました' });
    }
});

// 決済場所自動補完API
app.get('/api/payment-locations', async (req, res) => {
    try {
        const { search } = req.query;
        let query = 'SELECT * FROM payment_locations ORDER BY usage_count DESC, name';
        let params = [];
        
        if (search) {
            query = 'SELECT * FROM payment_locations WHERE name LIKE ? ORDER BY usage_count DESC, name LIMIT 10';
            params = [`%${search}%`];
        }
        
        const locations = await db.all(query, params);
        res.json(locations);
    } catch (error) {
        res.status(500).json({ error: '決済場所の取得に失敗しました' });
    }
});

// 個別取引取得API
app.get('/api/transactions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`個別取引取得: ID=${id}`);
        const transaction = await db.get(
            `SELECT t.*, ec.name as expense_category_name, 
                   wc.name as wallet_category_name, cc.name as credit_category_name
             FROM transactions t
             LEFT JOIN expense_categories ec ON t.expense_category_id = ec.id
             LEFT JOIN wallet_categories wc ON t.wallet_category_id = wc.id
             LEFT JOIN credit_categories cc ON t.credit_category_id = cc.id
             WHERE t.id = ?`,
            [id]
        );

        if (!transaction) {
            console.log(`取引ID ${id} が見つかりません`);
            return res.status(404).json({ error: '取引が見つかりません' });
        }
        
        console.log(`取引データ取得成功: ${transaction.description}`);

        // 商品詳細を追加（テーブルが存在する場合のみ）
        try {
            let tableExists;
            if (db.type === 'postgresql') {
                tableExists = await db.get("SELECT table_name FROM information_schema.tables WHERE table_name = 'transaction_items'");
            } else {
                tableExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='transaction_items'");
            }
            if (tableExists) {
                const items = await db.all(
                    `SELECT ti.*, ec.name as expense_category_name 
                     FROM transaction_items ti
                     LEFT JOIN expense_categories ec ON ti.expense_category_id = ec.id
                     WHERE ti.transaction_id = ?`,
                    [id]
                );
                transaction.items = items;
            } else {
                transaction.items = [];
            }
        } catch (itemError) {
            console.warn('個別取引の商品詳細取得エラー:', itemError);
            transaction.items = [];
        }

        res.json(transaction);
    } catch (error) {
        console.error('個別取引取得エラー:', error);
        res.status(500).json({ error: '取引の取得に失敗しました' });
    }
});

// 取引記録API
app.get('/api/transactions', async (req, res) => {
    try {
        const { date, month } = req.query;
        console.log(`取引取得リクエスト: date=${date}, month=${month}`);
        
        let query = `
            SELECT t.*, ec.name as expense_category_name, 
                   wc.name as wallet_category_name, cc.name as credit_category_name
            FROM transactions t
            LEFT JOIN expense_categories ec ON t.expense_category_id = ec.id
            LEFT JOIN wallet_categories wc ON t.wallet_category_id = wc.id
            LEFT JOIN credit_categories cc ON t.credit_category_id = cc.id
        `;
        let params = [];

        if (date) {
            query += ' WHERE DATE(t.date) = ?';
            params.push(date);
        } else if (month) {
            query += ' WHERE strftime("%Y-%m", t.date) = ?';
            params.push(month);
        }

        query += ' ORDER BY t.date DESC, t.created_at DESC';
        console.log(`実行するクエリ: ${query}`, params);

        const transactions = await db.all(query, params);
        
        // 各取引に商品詳細を追加（テーブルが存在する場合のみ）
        try {
            let tableExists;
            if (db.type === 'postgresql') {
                tableExists = await db.get("SELECT table_name FROM information_schema.tables WHERE table_name = 'transaction_items'");
            } else {
                tableExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='transaction_items'");
            }
            if (tableExists) {
                for (const transaction of transactions) {
                    const items = await db.all(
                        `SELECT ti.*, ec.name as expense_category_name 
                         FROM transaction_items ti
                         LEFT JOIN expense_categories ec ON ti.expense_category_id = ec.id 
                         WHERE ti.transaction_id = ?`,
                        [transaction.id]
                    );
                    transaction.items = items;
                }
            } else {
                console.log('transaction_itemsテーブルが存在しません。商品詳細はスキップします。');
                for (const transaction of transactions) {
                    transaction.items = [];
                }
            }
        } catch (itemError) {
            console.warn('商品詳細取得エラー:', itemError);
            for (const transaction of transactions) {
                transaction.items = [];
            }
        }
        
        console.log(`取得された取引数: ${transactions.length}`);
        res.json(transactions);
    } catch (error) {
        console.error('取引取得エラー:', error);
        res.status(500).json({ error: '取引記録の取得に失敗しました' });
    }
});

app.post('/api/transactions', async (req, res) => {
    try {
        const { date, amount, type, expense_category_id, wallet_category_id, credit_category_id, transfer_from_wallet_id, transfer_to_wallet_id, charge_from_credit_id, charge_to_wallet_id, budget_from_category_id, budget_to_category_id, description, memo, payment_location, notes, items } = req.body;

        if (type === 'transfer') {
            // 振替・引落処理
            if (!transfer_from_wallet_id || !transfer_to_wallet_id) {
                return res.status(400).json({ error: '振替元と振替先を指定してください' });
            }
            
            if (transfer_from_wallet_id === transfer_to_wallet_id) {
                return res.status(400).json({ error: '振替元と振替先が同じです' });
            }

            // 振替元の残高確認
            const fromWallet = await db.get('SELECT balance FROM wallet_categories WHERE id = ?', [transfer_from_wallet_id]);
            if (!fromWallet || fromWallet.balance < amount) {
                return res.status(400).json({ error: '振替元の残高が不足しています' });
            }

            if (transfer_to_wallet_id === 'withdrawal') {
                // 引落の場合：元財布から減額のみ
                const outResult = await db.run(
                    `INSERT INTO transactions (date, amount, type, wallet_category_id, description, memo, payment_location, notes)
                     VALUES (?, ?, 'expense', ?, ?, ?, ?, ?)`,
                    [date, amount, transfer_from_wallet_id, `引落: ${description || '引落処理'}`, memo, payment_location, notes]
                );

                // 元財布残高を減額
                await db.run(
                    'UPDATE wallet_categories SET balance = balance - ? WHERE id = ?',
                    [amount, transfer_from_wallet_id]
                );

                res.json({ 
                    id: outResult.lastID,
                    message: '引落を記録しました' 
                });
            } else {
                // 通常の振替の場合：2つの取引記録を作成
                const outResult = await db.run(
                    `INSERT INTO transactions (date, amount, type, wallet_category_id, description, memo, payment_location, notes)
                     VALUES (?, ?, 'expense', ?, ?, ?, ?, ?)`,
                    [date, amount, transfer_from_wallet_id, `振替出金: ${description || '財布間振替'}`, memo, payment_location, notes]
                );
                
                const inResult = await db.run(
                    `INSERT INTO transactions (date, amount, type, wallet_category_id, description, memo, payment_location, notes)
                     VALUES (?, ?, 'income', ?, ?, ?, ?, ?)`,
                    [date, amount, transfer_to_wallet_id, `振替入金: ${description || '財布間振替'}`, memo, payment_location, notes]
                );

                // 財布残高を更新
                await db.run(
                    'UPDATE wallet_categories SET balance = balance - ? WHERE id = ?',
                    [amount, transfer_from_wallet_id]
                );
                
                await db.run(
                    'UPDATE wallet_categories SET balance = balance + ? WHERE id = ?',
                    [amount, transfer_to_wallet_id]
                );

                res.json({ 
                    id: outResult.lastID,
                    transferId: inResult.lastID,
                    message: '振替を記録しました' 
                });
            }
        } else if (type === 'budget_transfer') {
            // 予算振替処理
            if (!budget_from_category_id || !budget_to_category_id) {
                return res.status(400).json({ error: '振替元と振替先の予算カテゴリを指定してください' });
            }
            
            if (budget_from_category_id === budget_to_category_id) {
                return res.status(400).json({ error: '振替元と振替先の予算カテゴリが同じです' });
            }

            // 取引の年月を取得
            const transactionDate = new Date(date);
            const year = transactionDate.getFullYear();
            const month = transactionDate.getMonth() + 1;

            // 振替元カテゴリの現在の予算残高を取得
            const fromCategoryBalance = await db.get(
                `SELECT ec.name as category_name,
                        COALESCE(mb.budget_amount, 0) as budget,
                        (COALESCE(mb.budget_amount, 0) - 
                         (COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) -
                          COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END), 0))) as remaining
                 FROM expense_categories ec
                 LEFT JOIN transactions t ON ec.id = t.expense_category_id 
                     AND t.type IN ('expense', 'income') AND strftime('%Y-%m', t.date) = ?
                 LEFT JOIN monthly_budgets mb ON ec.id = mb.expense_category_id 
                     AND mb.year = ? AND mb.month = ?
                 WHERE ec.id = ?
                 GROUP BY ec.id, ec.name, mb.budget_amount`,
                [`${year}-${month.toString().padStart(2, '0')}`, year, month, budget_from_category_id]
            );

            // 振替元の残高確認
            if (!fromCategoryBalance || fromCategoryBalance.remaining < amount) {
                return res.status(400).json({ 
                    error: '振替元カテゴリの予算残高が不足しています',
                    available: fromCategoryBalance ? fromCategoryBalance.remaining : 0
                });
            }

            // 予算振替の記録（収入・支出の取引として記録して実際の予算残高を移行）
            const budgetOutResult = await db.run(
                `INSERT INTO transactions (date, amount, type, expense_category_id, description, memo, payment_location, notes)
                 VALUES (?, ?, 'expense', ?, ?, ?, ?, ?)`,
                [date, amount, budget_from_category_id, `予算振替（減額）: ${description || '予算間振替'}`, memo, payment_location, notes]
            );

            const budgetInResult = await db.run(
                `INSERT INTO transactions (date, amount, type, expense_category_id, description, memo, payment_location, notes)
                 VALUES (?, ?, 'income', ?, ?, ?, ?, ?)`,
                [date, amount, budget_to_category_id, `予算振替（増額）: ${description || '予算間振替'}`, memo, payment_location, notes]
            );

            res.json({ 
                id: budgetOutResult.lastID,
                budgetTransferId: budgetInResult.lastID,
                message: '予算振替を記録しました',
                transferred_amount: amount,
                from_category: fromCategoryBalance.category_name
            });
        } else if (type === 'charge') {
            // チャージ処理（クレジットまたは財布から財布へ）
            if (!charge_to_wallet_id) {
                return res.status(400).json({ error: 'チャージ先財布を指定してください' });
            }

            if (charge_from_credit_id) {
                // クレジットから財布へのチャージ
                // 2つの取引記録を作成（クレジット使用記録、財布への入金記録）
                const chargeExpenseResult = await db.run(
                    `INSERT INTO transactions (date, amount, type, credit_category_id, description, memo, payment_location, notes)
                     VALUES (?, ?, 'expense', ?, ?, ?, ?, ?)`,
                    [date, amount, charge_from_credit_id, `チャージ: ${description || 'クレジットチャージ'}`, memo, payment_location, notes]
                );
                
                const chargeIncomeResult = await db.run(
                    `INSERT INTO transactions (date, amount, type, wallet_category_id, description, memo, payment_location, notes)
                     VALUES (?, ?, 'income', ?, ?, ?, ?, ?)`,
                    [date, amount, charge_to_wallet_id, `チャージ入金: ${description || 'クレジットチャージ'}`, memo, payment_location, notes]
                );

                // 財布残高を更新（入金）
                await db.run(
                    'UPDATE wallet_categories SET balance = balance + ? WHERE id = ?',
                    [amount, charge_to_wallet_id]
                );

                // クレジット使用額サマリーを更新
                const transactionDate = new Date(date);
                const year = transactionDate.getFullYear();
                const month = transactionDate.getMonth() + 1;

                await db.run(
                    `INSERT OR REPLACE INTO monthly_credit_summary (year, month, credit_category_id, total_amount)
                     VALUES (?, ?, ?, COALESCE((
                         SELECT total_amount FROM monthly_credit_summary 
                         WHERE year = ? AND month = ? AND credit_category_id = ?
                     ), 0) + ?)`,
                    [year, month, charge_from_credit_id, year, month, charge_from_credit_id, amount]
                );

                res.json({ 
                    id: chargeExpenseResult.lastID,
                    chargeId: chargeIncomeResult.lastID,
                    message: 'クレジットチャージを記録しました' 
                });
            } else if (charge_from_wallet_id) {
                // 財布から財布へのチャージ
                if (charge_from_wallet_id === charge_to_wallet_id) {
                    return res.status(400).json({ error: 'チャージ元と先の財布が同じです' });
                }

                // 2つの取引記録を作成（チャージ元からの出金記録、チャージ先への入金記録）
                const chargeOutResult = await db.run(
                    `INSERT INTO transactions (date, amount, type, wallet_category_id, description, memo, payment_location, notes)
                     VALUES (?, ?, 'expense', ?, ?, ?, ?, ?)`,
                    [date, amount, charge_from_wallet_id, `チャージ: ${description || '財布チャージ'}`, memo, payment_location, notes]
                );
                
                const chargeInResult = await db.run(
                    `INSERT INTO transactions (date, amount, type, wallet_category_id, description, memo, payment_location, notes)
                     VALUES (?, ?, 'income', ?, ?, ?, ?, ?)`,
                    [date, amount, charge_to_wallet_id, `チャージ入金: ${description || '財布チャージ'}`, memo, payment_location, notes]
                );

                // 財布残高を更新
                await db.run(
                    'UPDATE wallet_categories SET balance = balance - ? WHERE id = ?',
                    [amount, charge_from_wallet_id]
                );
                
                await db.run(
                    'UPDATE wallet_categories SET balance = balance + ? WHERE id = ?',
                    [amount, charge_to_wallet_id]
                );

                res.json({ 
                    id: chargeOutResult.lastID,
                    chargeId: chargeInResult.lastID,
                    message: '財布チャージを記録しました' 
                });
            } else {
                return res.status(400).json({ error: 'チャージ元（クレジットカードまたは財布）を指定してください' });
            }
        } else {
            // 通常の収入・支出処理
            const result = await db.run(
                `INSERT INTO transactions (date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, payment_location, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, payment_location, notes]
            );

            // 商品詳細がある場合は保存
            if (items && items.length > 0) {
                for (const item of items) {
                    await db.run(
                        `INSERT INTO transaction_items (transaction_id, item_name, amount, expense_category_id)
                         VALUES (?, ?, ?, ?)`,
                        [result.lastID, item.name, item.amount, item.expense_category_id || expense_category_id]
                    );
                }
            }

            // 決済場所をマスタに追加/更新（使用回数カウント）
            if (payment_location) {
                await db.run(
                    `INSERT INTO payment_locations (name, usage_count) 
                     VALUES (?, 1) 
                     ON CONFLICT(name) DO UPDATE SET 
                         usage_count = usage_count + 1, 
                         updated_at = CURRENT_TIMESTAMP`,
                    [payment_location]
                );
            }

            // 財布残高を更新
            if (type === 'expense' && wallet_category_id) {
                await db.run(
                    'UPDATE wallet_categories SET balance = balance - ? WHERE id = ?',
                    [amount, wallet_category_id]
                );
            } else if (type === 'income' && wallet_category_id) {
                await db.run(
                    'UPDATE wallet_categories SET balance = balance + ? WHERE id = ?',
                    [amount, wallet_category_id]
                );
            }

            // クレジット使用額サマリーを更新
            if (type === 'expense' && credit_category_id) {
                const transactionDate = new Date(date);
                const year = transactionDate.getFullYear();
                const month = transactionDate.getMonth() + 1;

                await db.run(
                    `INSERT OR REPLACE INTO monthly_credit_summary (year, month, credit_category_id, total_amount)
                     VALUES (?, ?, ?, COALESCE((
                         SELECT total_amount FROM monthly_credit_summary 
                         WHERE year = ? AND month = ? AND credit_category_id = ?
                     ), 0) + ?)`,
                    [year, month, credit_category_id, year, month, credit_category_id, amount]
                );
            }

            res.json({ id: result.lastID, message: '取引を記録しました' });
        }
    } catch (error) {
        console.error('取引記録エラー:', error);
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            errno: error.errno
        });
        res.status(500).json({ 
            error: '取引の記録に失敗しました',
            details: error.message 
        });
    }
});

// 取引更新API
app.put('/api/transactions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, payment_location, notes, items } = req.body;

        // 既存の取引を取得
        const existingTransaction = await db.get('SELECT * FROM transactions WHERE id = ?', [id]);
        if (!existingTransaction) {
            return res.status(404).json({ error: '取引が見つかりません' });
        }

        // 既存の財布残高やクレジット使用額を元に戻す
        if (existingTransaction.type === 'expense' && existingTransaction.wallet_category_id) {
            await db.run(
                'UPDATE wallet_categories SET balance = balance + ? WHERE id = ?',
                [existingTransaction.amount, existingTransaction.wallet_category_id]
            );
        } else if (existingTransaction.type === 'income' && existingTransaction.wallet_category_id) {
            await db.run(
                'UPDATE wallet_categories SET balance = balance - ? WHERE id = ?',
                [existingTransaction.amount, existingTransaction.wallet_category_id]
            );
        }

        if (existingTransaction.type === 'expense' && existingTransaction.credit_category_id) {
            const existingDate = new Date(existingTransaction.date);
            const existingYear = existingDate.getFullYear();
            const existingMonth = existingDate.getMonth() + 1;

            await db.run(
                `UPDATE monthly_credit_summary 
                 SET total_amount = total_amount - ? 
                 WHERE year = ? AND month = ? AND credit_category_id = ?`,
                [existingTransaction.amount, existingYear, existingMonth, existingTransaction.credit_category_id]
            );
        }

        // 既存の商品詳細を削除（テーブルが存在する場合のみ）
        try {
            let tableExists;
            if (db.type === 'postgresql') {
                tableExists = await db.get("SELECT table_name FROM information_schema.tables WHERE table_name = 'transaction_items'");
            } else {
                tableExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='transaction_items'");
            }
            if (tableExists) {
                await db.run('DELETE FROM transaction_items WHERE transaction_id = ?', [id]);
            }
        } catch (itemError) {
            console.warn('既存商品詳細削除エラー:', itemError);
        }

        // 取引を更新
        await db.run(
            `UPDATE transactions 
             SET date = ?, amount = ?, type = ?, expense_category_id = ?, 
                 wallet_category_id = ?, credit_category_id = ?, description = ?, 
                 memo = ?, payment_location = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [date, amount, type, expense_category_id, wallet_category_id, credit_category_id, description, memo, payment_location, notes, id]
        );

        // 新しい商品詳細を追加
        if (items && items.length > 0) {
            for (const item of items) {
                await db.run(
                    `INSERT INTO transaction_items (transaction_id, item_name, amount, expense_category_id)
                     VALUES (?, ?, ?, ?)`,
                    [id, item.name, item.amount, item.expense_category_id || expense_category_id]
                );
            }
        }

        // 決済場所をマスタに追加/更新
        if (payment_location) {
            await db.run(
                `INSERT INTO payment_locations (name, usage_count) 
                 VALUES (?, 1) 
                 ON CONFLICT(name) DO UPDATE SET 
                     usage_count = usage_count + 1, 
                     updated_at = CURRENT_TIMESTAMP`,
                [payment_location]
            );
        }

        // 新しい財布残高を更新
        if (type === 'expense' && wallet_category_id) {
            await db.run(
                'UPDATE wallet_categories SET balance = balance - ? WHERE id = ?',
                [amount, wallet_category_id]
            );
        } else if (type === 'income' && wallet_category_id) {
            await db.run(
                'UPDATE wallet_categories SET balance = balance + ? WHERE id = ?',
                [amount, wallet_category_id]
            );
        }

        // 新しいクレジット使用額サマリーを更新
        if (type === 'expense' && credit_category_id) {
            const transactionDate = new Date(date);
            const year = transactionDate.getFullYear();
            const month = transactionDate.getMonth() + 1;

            await db.run(
                `INSERT OR REPLACE INTO monthly_credit_summary (year, month, credit_category_id, total_amount)
                 VALUES (?, ?, ?, COALESCE((
                     SELECT total_amount FROM monthly_credit_summary 
                     WHERE year = ? AND month = ? AND credit_category_id = ?
                 ), 0) + ?)`,
                [year, month, credit_category_id, year, month, credit_category_id, amount]
            );
        }

        res.json({ message: '取引を更新しました' });
    } catch (error) {
        console.error('取引更新エラー:', error);
        res.status(500).json({ error: '取引の更新に失敗しました' });
    }
});

// 取引削除API
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // 削除する取引を取得
        const transaction = await db.get('SELECT * FROM transactions WHERE id = ?', [id]);
        if (!transaction) {
            return res.status(404).json({ error: '取引が見つかりません' });
        }

        // 財布残高を元に戻す
        if (transaction.type === 'expense' && transaction.wallet_category_id) {
            await db.run(
                'UPDATE wallet_categories SET balance = balance + ? WHERE id = ?',
                [transaction.amount, transaction.wallet_category_id]
            );
        } else if (transaction.type === 'income' && transaction.wallet_category_id) {
            await db.run(
                'UPDATE wallet_categories SET balance = balance - ? WHERE id = ?',
                [transaction.amount, transaction.wallet_category_id]
            );
        }

        // クレジット使用額サマリーを元に戻す
        if (transaction.type === 'expense' && transaction.credit_category_id) {
            const transactionDate = new Date(transaction.date);
            const year = transactionDate.getFullYear();
            const month = transactionDate.getMonth() + 1;

            await db.run(
                `UPDATE monthly_credit_summary 
                 SET total_amount = total_amount - ? 
                 WHERE year = ? AND month = ? AND credit_category_id = ?`,
                [transaction.amount, year, month, transaction.credit_category_id]
            );
        }

        // 商品詳細を削除（テーブルが存在する場合のみ）
        try {
            const tableExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='transaction_items'");
            if (tableExists) {
                await db.run('DELETE FROM transaction_items WHERE transaction_id = ?', [id]);
            }
        } catch (itemError) {
            console.warn('商品詳細削除エラー:', itemError);
        }

        // 取引を削除
        await db.run('DELETE FROM transactions WHERE id = ?', [id]);

        res.json({ message: '取引を削除しました' });
    } catch (error) {
        console.error('取引削除エラー:', error);
        res.status(500).json({ error: '取引の削除に失敗しました' });
    }
});

// 日付別取引取得API
app.get('/api/transactions/date/:date', async (req, res) => {
    try {
        const { date } = req.params;
        console.log(`日付別取引取得: ${date}`);
        
        const transactions = await db.all(`
            SELECT 
                t.*,
                ec.name as expense_category_name,
                wc.name as wallet_category_name,
                cc.name as credit_category_name
            FROM transactions t
            LEFT JOIN expense_categories ec ON t.expense_category_id = ec.id
            LEFT JOIN wallet_categories wc ON t.wallet_category_id = wc.id
            LEFT JOIN credit_categories cc ON t.credit_category_id = cc.id
            WHERE date(t.date) = date(?)
            ORDER BY t.created_at DESC
        `, [date]);
        
        console.log(`取得された取引数: ${transactions.length}`);
        res.json(transactions);
    } catch (error) {
        console.error('日付別取引取得エラー:', error);
        res.status(500).json({ error: '取引の取得に失敗しました' });
    }
});

// 予算管理API
app.get('/api/budgets/:year/:month', async (req, res) => {
    try {
        const { year, month } = req.params;
        const budgets = await db.all(
            `SELECT mb.*, ec.name as category_name
             FROM monthly_budgets mb
             JOIN expense_categories ec ON mb.expense_category_id = ec.id
             WHERE mb.year = ? AND mb.month = ?`,
            [year, month]
        );
        res.json(budgets);
    } catch (error) {
        res.status(500).json({ error: '予算の取得に失敗しました' });
    }
});

app.post('/api/budgets', async (req, res) => {
    try {
        const { year, month, expense_category_id, budget_amount } = req.body;
        await db.run(
            `INSERT OR REPLACE INTO monthly_budgets (year, month, expense_category_id, budget_amount)
             VALUES (?, ?, ?, ?)`,
            [year, month, expense_category_id, budget_amount]
        );
        res.json({ message: '予算を設定しました' });
    } catch (error) {
        res.status(500).json({ error: '予算の設定に失敗しました' });
    }
});

// 予算調整API
app.post('/api/budget-adjustments', async (req, res) => {
    try {
        const { year, month, category_id, adjustment_amount, description } = req.body;
        console.log('予算調整リクエスト:', { year, month, category_id, adjustment_amount, description });
        
        if (!year || !month || !category_id || !adjustment_amount) {
            return res.status(400).json({ error: '必要なパラメータが不足しています' });
        }
        
        // 調整取引を作成（収入/支出として記録）
        const transactionType = adjustment_amount > 0 ? 'income' : 'expense';
        const amount = Math.abs(adjustment_amount);
        const adjustmentDate = `${year}-${month.toString().padStart(2, '0')}-01`;
        
        const result = await db.run(
            `INSERT INTO transactions (date, amount, type, expense_category_id, description, memo, payment_location, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                adjustmentDate, 
                amount, 
                transactionType, 
                category_id, 
                description || '予算残高調整',
                'システムによる予算残高調整',
                '予算調整',
                `手動調整: ${adjustment_amount > 0 ? '+' : ''}¥${adjustment_amount.toLocaleString()}`
            ]
        );
        
        res.json({ 
            id: result.lastID, 
            message: '予算調整を記録しました',
            adjustment_amount: adjustment_amount
        });
        
    } catch (error) {
        console.error('予算調整エラー:', error);
        res.status(500).json({ error: '予算調整の記録に失敗しました' });
    }
});

// 財布残高更新API
app.put('/api/wallets/:id/balance', async (req, res) => {
    try {
        const { id } = req.params;
        const { balance } = req.body;
        await db.run('UPDATE wallet_categories SET balance = ? WHERE id = ?', [balance, id]);
        res.json({ message: '残高を更新しました' });
    } catch (error) {
        res.status(500).json({ error: '残高の更新に失敗しました' });
    }
});

// レシート解析API
app.post('/api/analyze-receipt', upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'ファイルがアップロードされていません' });
        }

        const axios = require('axios');
        const base64Image = req.file.buffer.toString('base64');

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: `このレシート画像を解析して、以下のJSON形式で正確に回答してください。

【重要】店舗名は絶対に商品名に含めないでください。商品リスト部分のみから商品名を抽出してください。

解析例：
- 店舗名「セブンイレブン」がレシートの上部にある場合、これを商品名に含めない
- 商品リスト：「おにぎり 120円」「お茶 108円」の場合、商品名は「おにぎり」「お茶」のみ

JSON形式（説明文・マークダウン不要）:
{
  "total_amount": 合計金額の数値,
  "items": [
    {"name": "商品名のみ", "amount": 商品金額の数値}
  ],
  "store_name": "店舗名",
  "date": "YYYY-MM-DD",
  "suggested_category": "食費、生活費、養育費、ローン、小遣い、娯楽費、車維持費、医療費、公共料金、投資のいずれか"
}

注意：
1. store_nameは上部の店舗名から取得
2. itemsは商品リスト部分からのみ取得
3. この2つを絶対に混同しない`
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 600,
            temperature: 0.2
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        let content = response.data.choices[0].message.content;
        console.log('OpenAI Response:', content);
        
        // Markdownのコードブロック（```json```）を除去
        if (content.includes('```json')) {
            content = content.replace(/```json\s*/, '').replace(/```$/, '').trim();
        } else if (content.includes('```')) {
            content = content.replace(/```\s*/, '').replace(/```$/, '').trim();
        }
        
        try {
            const analysis = JSON.parse(content);
            
            console.log('🤖 AI生データ:', {
                store_name: analysis.store_name,
                items_count: analysis.items?.length,
                first_item: analysis.items?.[0]?.name,
                all_items: analysis.items?.map(item => item.name)
            });
            
            // 解析結果の検証と修正
            const validatedAnalysis = validateAndFixReceiptAnalysis(analysis);
            
            console.log('✅ 修正後データ:', {
                store_name: validatedAnalysis.store_name,
                items_count: validatedAnalysis.items.length,
                first_item: validatedAnalysis.items[0]?.name,
                all_items: validatedAnalysis.items.map(item => item.name)
            });
            
            res.json(validatedAnalysis);
        } catch (parseError) {
            console.error('JSON Parse Error:', parseError);
            console.error('Content that failed to parse:', content);
            res.status(500).json({ 
                error: 'AIからの応答の解析に失敗しました',
                rawContent: content
            });
        }
    } catch (error) {
        console.error('レシート解析エラー:', error);
        if (error.response) {
            console.error('OpenAI API Error:', error.response.status, error.response.data);
            res.status(error.response.status).json({ 
                error: 'OpenAI APIエラー',
                details: error.response.data
            });
        } else {
            console.error('Network Error:', error.message);
            res.status(500).json({ 
                error: 'レシートの解析に失敗しました',
                details: error.message
            });
        }
    }
});

// 集計API
app.get('/api/summary/:year/:month', async (req, res) => {
    try {
        const { year, month } = req.params;
        
        // 出費カテゴリ別集計（支出から収入を引いた正味支出）
        const expenseSummary = await db.all(
            `SELECT ec.name as category, 
                    COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) -
                    COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END), 0) as total,
                    COALESCE(mb.budget_amount, 0) as budget,
                    (COALESCE(mb.budget_amount, 0) - 
                     (COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) -
                      COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END), 0))) as remaining,
                    ec.id as category_id
             FROM expense_categories ec
             LEFT JOIN transactions t ON ec.id = t.expense_category_id 
                 AND t.type IN ('expense', 'income') AND strftime('%Y-%m', t.date) = ?
             LEFT JOIN monthly_budgets mb ON ec.id = mb.expense_category_id 
                 AND mb.year = ? AND mb.month = ?
             GROUP BY ec.id, ec.name, mb.budget_amount
             ORDER BY ec.name`,
            [`${year}-${month.toString().padStart(2, '0')}`, year, month]
        );

        // クレジット使用額集計
        const creditSummary = await db.all(
            `SELECT cc.name as category, COALESCE(mcs.total_amount, 0) as total, cc.id as category_id
             FROM credit_categories cc
             LEFT JOIN monthly_credit_summary mcs ON cc.id = mcs.credit_category_id 
                 AND mcs.year = ? AND mcs.month = ?
             ORDER BY cc.name`,
            [year, month]
        );

        res.json({ expenseSummary, creditSummary });
    } catch (error) {
        console.error('集計エラー:', error);
        res.status(500).json({ error: '集計の取得に失敗しました' });
    }
});

// カテゴリ別詳細取引取得API
app.get('/api/category-transactions/:year/:month/:categoryId/:categoryType', async (req, res) => {
    try {
        const { year, month, categoryId, categoryType } = req.params;
        const yearMonth = `${year}-${month.toString().padStart(2, '0')}`;
        
        let query, params;
        
        if (categoryType === 'expense') {
            // 出費カテゴリの取引
            query = `
                SELECT t.*, ec.name as expense_category_name, 
                       wc.name as wallet_category_name, cc.name as credit_category_name
                FROM transactions t
                LEFT JOIN expense_categories ec ON t.expense_category_id = ec.id
                LEFT JOIN wallet_categories wc ON t.wallet_category_id = wc.id
                LEFT JOIN credit_categories cc ON t.credit_category_id = cc.id
                WHERE t.expense_category_id = ? 
                    AND strftime('%Y-%m', t.date) = ?
                    AND t.type IN ('expense', 'income')
                ORDER BY t.date DESC, t.created_at DESC
            `;
            params = [categoryId, yearMonth];
        } else if (categoryType === 'credit') {
            // クレジットカテゴリの取引
            query = `
                SELECT t.*, ec.name as expense_category_name, 
                       wc.name as wallet_category_name, cc.name as credit_category_name
                FROM transactions t
                LEFT JOIN expense_categories ec ON t.expense_category_id = ec.id
                LEFT JOIN wallet_categories wc ON t.wallet_category_id = wc.id
                LEFT JOIN credit_categories cc ON t.credit_category_id = cc.id
                WHERE t.credit_category_id = ? 
                    AND strftime('%Y-%m', t.date) = ?
                    AND t.type = 'expense'
                ORDER BY t.date DESC, t.created_at DESC
            `;
            params = [categoryId, yearMonth];
        } else {
            return res.status(400).json({ error: '不正なカテゴリタイプです' });
        }
        
        const transactions = await db.all(query, params);
        res.json(transactions);
        
    } catch (error) {
        console.error('カテゴリ別取引取得エラー:', error);
        res.status(500).json({ error: 'カテゴリ別取引の取得に失敗しました' });
    }
});

// 財布別詳細取引取得API
app.get('/api/wallet-transactions/:year/:month/:walletId', async (req, res) => {
    try {
        const { year, month, walletId } = req.params;
        const yearMonth = `${year}-${month.toString().padStart(2, '0')}`;
        
        const transactions = await db.all(`
            SELECT t.*, ec.name as expense_category_name, 
                   wc.name as wallet_category_name, cc.name as credit_category_name
            FROM transactions t
            LEFT JOIN expense_categories ec ON t.expense_category_id = ec.id
            LEFT JOIN wallet_categories wc ON t.wallet_category_id = wc.id
            LEFT JOIN credit_categories cc ON t.credit_category_id = cc.id
            WHERE t.wallet_category_id = ? 
                AND strftime('%Y-%m', t.date) = ?
            ORDER BY t.date DESC, t.created_at DESC
        `, [walletId, yearMonth]);
        
        res.json(transactions);
        
    } catch (error) {
        console.error('財布別取引取得エラー:', error);
        res.status(500).json({ error: '財布別取引の取得に失敗しました' });
    }
});

// レシート解析結果の検証と修正
function validateAndFixReceiptAnalysis(analysis) {
    try {
        // デフォルト値の設定
        const validated = {
            total_amount: 0,
            items: [],
            store_name: analysis.store_name || '不明',
            date: analysis.date || new Date().toISOString().split('T')[0],
            suggested_category: analysis.suggested_category || '食費'
        };
        
        // 商品リストの検証と修正
        if (analysis.items && Array.isArray(analysis.items)) {
            let filteredItems = analysis.items.filter(item => {
                // 有効な商品のみ残す
                return item && 
                       typeof item.name === 'string' && 
                       item.name.trim().length > 0 &&
                       !isNaN(parseFloat(item.amount)) &&
                       parseFloat(item.amount) > 0;
            });
            
            // 店舗名が商品名に混入しているアイテムを除外
            if (validated.store_name && validated.store_name !== '不明') {
                const storeName = validated.store_name.trim();
                
                filteredItems = filteredItems.filter((item, index) => {
                    const itemName = item.name.trim();
                    
                    // 店舗名パターンの検出
                    const isStoreName = (
                        itemName === storeName || 
                        itemName.includes(storeName) || 
                        storeName.includes(itemName) ||
                        // 一般的な店舗名パターンもチェック
                        /セブンイレブン|ファミマ|ローソン|スーパー|薬局|ドラッグ|コンビニ|店舗|マート|株式会社|有限会社/i.test(itemName) ||
                        // 住所・電話番号パターン
                        /\d{2,3}-\d{4}-\d{4}|\d{1,3}-\d{1,4}-\d{1,4}/.test(itemName) ||
                        // 金額が異常に大きい（合計金額と近い）場合
                        (item.amount && Math.abs(item.amount - (analysis.total_amount || 0)) < 10) ||
                        // 非商品的なキーワード
                        /領収書|レシート|ありがとうござい|またお越し|合計|小計|税込|税抜/i.test(itemName)
                    );
                    
                    if (isStoreName) {
                        console.log(`非商品アイテムを除外[${index}]: "${itemName}" (金額: ${item.amount})`);
                        return false;
                    }
                    
                    return true;
                });
            }
            
            validated.items = filteredItems.map(item => {
                    let cleanName = item.name.trim();
                    
                    // 店舗名が商品名に混入している場合の除去
                    const storeName = validated.store_name;
                    if (storeName && storeName !== '不明') {
                        // 店舗名を含む文字列を除去
                        cleanName = cleanName.replace(new RegExp(storeName, 'gi'), '').trim();
                    }
                    
                    // 一般的な店舗関連キーワードを除去
                    const storeKeywords = [
                        'セブンイレブン', 'ファミマ', 'ローソン', 'スーパー', '薬局',
                        'ドラッグ', 'コンビニ', '店', 'ストア', 'マート', 'shop', 'store'
                    ];
                    
                    storeKeywords.forEach(keyword => {
                        cleanName = cleanName.replace(new RegExp(keyword, 'gi'), '').trim();
                    });
                    
                    // その他のクリーニング
                    cleanName = cleanName
                        .replace(/^\d+\s*/, '') // 先頭の数字を除去
                        .replace(/\s+¥.*$/, '') // 末尾の金額情報を除去
                        .replace(/\s+\d+円.*$/, '') // 末尾の円表記を除去
                        .replace(/^[^\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]+/, '') // 先頭の特殊文字除去
                        .trim();
                    
                    return {
                        name: cleanName,
                        amount: parseFloat(item.amount)
                    };
                })
                .filter(item => item.name.length > 1 && 
                                !(/^[0-9\s\-]+$/.test(item.name))); // 空や数字のみの商品名を除外
        }
        
        // 合計金額の検証
        const itemsTotal = validated.items.reduce((sum, item) => sum + item.amount, 0);
        const originalTotal = parseFloat(analysis.total_amount) || 0;
        
        // 合計金額が商品合計と大きく異なる場合は商品合計を使用
        if (Math.abs(originalTotal - itemsTotal) > itemsTotal * 0.1 && itemsTotal > 0) {
            validated.total_amount = itemsTotal;
            console.log(`合計金額を修正: ${originalTotal} → ${itemsTotal}`);
        } else {
            validated.total_amount = originalTotal;
        }
        
        console.log('レシート解析結果検証完了:', {
            original_total: originalTotal,
            items_total: itemsTotal,
            final_total: validated.total_amount,
            items_count: validated.items.length
        });
        
        return validated;
        
    } catch (error) {
        console.error('レシート解析結果の検証エラー:', error);
        return analysis; // エラー時は元のデータをそのまま返す
    }
}

// 統計データAPI
app.get('/api/stats/:year/:month?', async (req, res) => {
    try {
        const { year, month } = req.params;
        console.log(`統計データ取得: year=${year}, month=${month}`);
        
        // 期間条件を構築
        let dateCondition = 'strftime("%Y", t.date) = ?';
        let params = [year];
        
        if (month) {
            dateCondition += ' AND strftime("%m", t.date) = ?';
            params.push(month.padStart(2, '0'));
        }
        
        // 月別収支データ（振替・チャージ・予算振替は収入から除外）
        const monthlyStats = await db.all(`
            SELECT 
                strftime('%Y-%m', t.date) as month,
                SUM(CASE 
                    WHEN t.type = 'income' 
                         AND t.description NOT LIKE '%振替%'
                         AND t.description NOT LIKE '%チャージ%'
                         AND t.description NOT LIKE '%予算振替%'
                         AND t.description NOT LIKE '%予算残高調整%'
                         AND t.payment_location != '予算調整'
                    THEN t.amount 
                    ELSE 0 
                END) as income,
                SUM(CASE 
                    WHEN t.type = 'expense'
                         AND t.description NOT LIKE '%振替%'
                         AND t.description NOT LIKE '%チャージ%'
                         AND t.description NOT LIKE '%予算振替%'
                         AND t.description NOT LIKE '%予算残高調整%'
                         AND t.payment_location != '予算調整'
                    THEN t.amount 
                    ELSE 0 
                END) as expense
            FROM transactions t
            WHERE ${dateCondition}
            GROUP BY strftime('%Y-%m', t.date)
            ORDER BY month
        `, params);
        
        // カテゴリ別支出データ（振替・チャージ・予算調整を除外）
        const categoryStats = await db.all(`
            SELECT 
                ec.name as category,
                SUM(t.amount) as total
            FROM transactions t
            JOIN expense_categories ec ON t.expense_category_id = ec.id
            WHERE t.type = 'expense' 
                AND ${dateCondition}
                AND t.description NOT LIKE '%振替%'
                AND t.description NOT LIKE '%チャージ%'
                AND t.description NOT LIKE '%予算振替%'
                AND t.description NOT LIKE '%予算残高調整%'
                AND t.payment_location != '予算調整'
            GROUP BY ec.id, ec.name
            HAVING total > 0
            ORDER BY total DESC
        `, params);
        
        // 財布別収支データ（振替・チャージ・予算振替は収入から除外）
        const walletStats = await db.all(`
            SELECT 
                wc.name as wallet,
                SUM(CASE 
                    WHEN t.type = 'income' 
                         AND t.description NOT LIKE '%振替%'
                         AND t.description NOT LIKE '%チャージ%'
                         AND t.description NOT LIKE '%予算振替%'
                         AND t.description NOT LIKE '%予算残高調整%'
                         AND t.payment_location != '予算調整'
                    THEN t.amount 
                    ELSE 0 
                END) as income,
                SUM(CASE 
                    WHEN t.type = 'expense'
                         AND t.description NOT LIKE '%振替%'
                         AND t.description NOT LIKE '%チャージ%'
                         AND t.description NOT LIKE '%予算振替%'
                         AND t.description NOT LIKE '%予算残高調整%'
                         AND t.payment_location != '予算調整'
                    THEN t.amount 
                    ELSE 0 
                END) as expense
            FROM transactions t
            JOIN wallet_categories wc ON t.wallet_category_id = wc.id
            WHERE ${dateCondition}
            GROUP BY wc.id, wc.name
            ORDER BY wc.name
        `, params);
        
        // 総計算（振替・チャージ・予算振替は収入から除外）
        const totals = await db.get(`
            SELECT 
                SUM(CASE 
                    WHEN t.type = 'income' 
                         AND t.description NOT LIKE '%振替%'
                         AND t.description NOT LIKE '%チャージ%'
                         AND t.description NOT LIKE '%予算振替%'
                         AND t.description NOT LIKE '%予算残高調整%'
                         AND t.payment_location != '予算調整'
                    THEN t.amount 
                    ELSE 0 
                END) as total_income,
                SUM(CASE 
                    WHEN t.type = 'expense'
                         AND t.description NOT LIKE '%振替%'
                         AND t.description NOT LIKE '%チャージ%'
                         AND t.description NOT LIKE '%予算振替%'
                         AND t.description NOT LIKE '%予算残高調整%'
                         AND t.payment_location != '予算調整'
                    THEN t.amount 
                    ELSE 0 
                END) as total_expense
            FROM transactions t
            WHERE ${dateCondition}
        `, params);
        
        res.json({
            monthlyStats,
            categoryStats,
            walletStats,
            totals: {
                income: totals.total_income || 0,
                expense: totals.total_expense || 0,
                net: (totals.total_income || 0) - (totals.total_expense || 0)
            }
        });
        
    } catch (error) {
        console.error('統計データ取得エラー:', error);
        res.status(500).json({ error: '統計データの取得に失敗しました' });
    }
});

// メインページ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 接続テスト用エンドポイント
app.get('/test', (req, res) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    res.json({
        message: '接続成功！',
        serverTime: new Date().toISOString(),
        clientIP: clientIP,
        userAgent: req.headers['user-agent']
    });
});

// サーバー起動
async function startServer() {
    try {
        // データベースは既にinitializeDatabase()で接続済み
        app.listen(PORT, '0.0.0.0', () => {
            const os = require('os');
            const networkInterfaces = os.networkInterfaces();
            let localIP = 'localhost';
            
            // ローカルIPアドレスを取得
            Object.keys(networkInterfaces).forEach(interfaceName => {
                networkInterfaces[interfaceName].forEach(interface => {
                    if (interface.family === 'IPv4' && !interface.internal) {
                        localIP = interface.address;
                    }
                });
            });
            
            console.log(`サーバーがポート ${PORT} で起動しました`);
            console.log(`\n📱 アクセス方法:`);
            console.log(`   PC: http://localhost:${PORT}`);
            console.log(`   スマホ: http://${localIP}:${PORT}`);
            console.log(`\n📌 スマホからアクセスする場合は、PC・スマホが同じWi-Fiに接続されている必要があります`);
        });
    } catch (error) {
        console.error('サーバー起動エラー:', error);
        process.exit(1);
    }
}

startServer();