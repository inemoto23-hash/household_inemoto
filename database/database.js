const sqlite3 = require('sqlite3').verbose();
const { Client } = require('pg');
const path = require('path');

class Database {
    constructor() {
        this.client = null;
        this.type = null;
    }

    async connect() {
        // 環境変数でPostgreSQLが設定されている場合はPostgreSQL、そうでなければSQLiteを使用
        if (process.env.DATABASE_URL) {
            console.log('PostgreSQLデータベースに接続中...');
            this.type = 'postgresql';
            this.client = new Client({
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
            });
            
            try {
                await this.client.connect();
                console.log('✅ PostgreSQLデータベース接続成功');
                await this.createTables();
            } catch (error) {
                console.error('PostgreSQL接続エラー:', error);
                console.log('SQLiteにフォールバック...');
                await this.connectSQLite();
            }
        } else {
            await this.connectSQLite();
        }
    }

    async connectSQLite() {
        console.log('SQLiteデータベースに接続中...');
        this.type = 'sqlite';
        const dbPath = path.join(__dirname, 'household_budget.db');
        
        return new Promise((resolve, reject) => {
            this.client = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
                if (err) {
                    console.error('SQLite接続エラー:', err);
                    reject(err);
                } else {
                    console.log('✅ SQLiteデータベース接続成功');
                    this.createTables().then(resolve).catch(reject);
                }
            });
        });
    }

    async createTables() {
        const idType = this.type === 'postgresql' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
        const timestampType = this.type === 'postgresql' ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';
        
        const tables = [
            `CREATE TABLE IF NOT EXISTS expense_categories (
                id ${idType},
                name TEXT NOT NULL UNIQUE,
                created_at ${timestampType}
            )`,
            
            `CREATE TABLE IF NOT EXISTS wallet_categories (
                id ${idType},
                name TEXT NOT NULL UNIQUE,
                balance DECIMAL(10,2) DEFAULT 0,
                created_at ${timestampType}
            )`,
            
            `CREATE TABLE IF NOT EXISTS credit_categories (
                id ${idType},
                name TEXT NOT NULL UNIQUE,
                created_at ${timestampType}
            )`,
            
            `CREATE TABLE IF NOT EXISTS transactions (
                id ${idType},
                date DATE NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                type TEXT CHECK(type IN ('income', 'expense', 'transfer', 'charge', 'budget_transfer')) NOT NULL,
                expense_category_id INTEGER,
                wallet_category_id INTEGER,
                credit_category_id INTEGER,
                description TEXT,
                memo TEXT DEFAULT '',
                created_at ${timestampType},
                updated_at ${timestampType},
                payment_location TEXT DEFAULT '',
                notes TEXT DEFAULT ''${this.type === 'sqlite' ? ',\n                FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id),\n                FOREIGN KEY (wallet_category_id) REFERENCES wallet_categories(id),\n                FOREIGN KEY (credit_category_id) REFERENCES credit_categories(id)' : ''}
            )`,
            
            `CREATE TABLE IF NOT EXISTS monthly_budgets (
                id ${idType},
                year INTEGER NOT NULL,
                month INTEGER NOT NULL,
                expense_category_id INTEGER NOT NULL,
                budget_amount DECIMAL(10,2) NOT NULL,
                created_at ${timestampType}${this.type === 'sqlite' ? ',\n                FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id),' : ','}
                UNIQUE(year, month, expense_category_id)
            )`,
            
            `CREATE TABLE IF NOT EXISTS monthly_credit_summary (
                id ${idType},
                year INTEGER NOT NULL,
                month INTEGER NOT NULL,
                credit_category_id INTEGER NOT NULL,
                total_amount DECIMAL(10,2) DEFAULT 0,
                created_at ${timestampType},
                updated_at ${timestampType}${this.type === 'sqlite' ? ',\n                FOREIGN KEY (credit_category_id) REFERENCES credit_categories(id),' : ','}
                UNIQUE(year, month, credit_category_id)
            )`
        ];

        for (const table of tables) {
            await this.run(table);
        }
        
        // PostgreSQLの場合は外部キー制約を追加
        if (this.type === 'postgresql') {
            const foreignKeys = [
                'ALTER TABLE transactions ADD CONSTRAINT IF NOT EXISTS fk_transactions_expense FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id)',
                'ALTER TABLE transactions ADD CONSTRAINT IF NOT EXISTS fk_transactions_wallet FOREIGN KEY (wallet_category_id) REFERENCES wallet_categories(id)', 
                'ALTER TABLE transactions ADD CONSTRAINT IF NOT EXISTS fk_transactions_credit FOREIGN KEY (credit_category_id) REFERENCES credit_categories(id)',
                'ALTER TABLE monthly_budgets ADD CONSTRAINT IF NOT EXISTS fk_budgets_expense FOREIGN KEY (expense_category_id) REFERENCES expense_categories(id)',
                'ALTER TABLE monthly_credit_summary ADD CONSTRAINT IF NOT EXISTS fk_credit_summary_credit FOREIGN KEY (credit_category_id) REFERENCES credit_categories(id)'
            ];
            
            for (const fk of foreignKeys) {
                try {
                    await this.run(fk);
                } catch (error) {
                    // 制約が既に存在する場合のエラーは無視
                    if (!error.message.includes('already exists')) {
                        console.warn('外部キー制約追加警告:', error.message);
                    }
                }
            }
        }
        
        console.log('✅ テーブル作成完了');
    }

    async run(sql, params = []) {
        if (this.type === 'postgresql') {
            try {
                const result = await this.client.query(sql, params);
                return result;
            } catch (error) {
                console.error('PostgreSQL実行エラー:', error);
                throw error;
            }
        } else {
            return new Promise((resolve, reject) => {
                this.client.run(sql, params, function(err) {
                    if (err) reject(err);
                    else resolve({ lastID: this.lastID, changes: this.changes });
                });
            });
        }
    }

    async get(sql, params = []) {
        if (this.type === 'postgresql') {
            try {
                const result = await this.client.query(sql, params);
                return result.rows[0] || null;
            } catch (error) {
                console.error('PostgreSQL取得エラー:', error);
                throw error;
            }
        } else {
            return new Promise((resolve, reject) => {
                this.client.get(sql, params, (err, row) => {
                    if (err) reject(err);
                    else resolve(row || null);
                });
            });
        }
    }

    async all(sql, params = []) {
        if (this.type === 'postgresql') {
            try {
                const result = await this.client.query(sql, params);
                return result.rows;
            } catch (error) {
                console.error('PostgreSQL全取得エラー:', error);
                throw error;
            }
        } else {
            return new Promise((resolve, reject) => {
                this.client.all(sql, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            });
        }
    }

    async close() {
        if (this.client) {
            if (this.type === 'postgresql') {
                await this.client.end();
            } else {
                this.client.close();
            }
        }
    }
}

// シングルトンインスタンスを作成
const database = new Database();

module.exports = database;