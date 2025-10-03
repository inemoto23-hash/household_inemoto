const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'budget.db');
const schemaPath = path.join(__dirname, 'schema.sql');

class Database {
    constructor() {
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(dbPath, (err) => {
                if (err) {
                    console.error('データベース接続エラー:', err);
                    reject(err);
                } else {
                    console.log('SQLiteデータベースに接続しました');
                    this.createTables()
                        .then(() => resolve())
                        .catch(reject);
                }
            });
        });
    }

    async createTables() {
        return new Promise((resolve, reject) => {
            // テーブルが存在するかチェック
            this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='expense_categories'", (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                if (row) {
                    // テーブルが既に存在する場合はマイグレーション実行
                    console.log('データベーステーブルは既に存在します');
                    this.runMigrations()
                        .then(() => resolve())
                        .catch(reject);
                    return;
                }

                // テーブルが存在しない場合のみ作成
                fs.readFile(schemaPath, 'utf8', (err, sql) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    this.db.exec(sql, (err) => {
                        if (err) {
                            console.error('テーブル作成エラー:', err);
                            reject(err);
                        } else {
                            console.log('データベーステーブルを作成しました');
                            resolve();
                        }
                    });
                });
            });
        });
    }

    async runMigrations() {
        return new Promise((resolve, reject) => {
            const migrationPath = path.join(__dirname, 'migration.sql');
            
            // マイグレーションファイルが存在するかチェック
            if (!fs.existsSync(migrationPath)) {
                // マイグレーション済みのため警告は不要
                resolve();
                return;
            }

            fs.readFile(migrationPath, 'utf8', (err, sql) => {
                if (err) {
                    console.error('マイグレーションファイル読み込みエラー:', err);
                    resolve(); // マイグレーションエラーでもアプリは起動する
                    return;
                }

                this.db.exec(sql, (err) => {
                    if (err) {
                        console.error('マイグレーション実行エラー:', err);
                        resolve(); // マイグレーションエラーでもアプリは起動する
                    } else {
                        console.log('データベースマイグレーションを実行しました');
                        resolve();
                    }
                });
            });
        });
    }

    get() {
        return new Promise((resolve, reject) => {
            this.db.get(...arguments, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    all() {
        return new Promise((resolve, reject) => {
            this.db.all(...arguments, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    run() {
        return new Promise((resolve, reject) => {
            this.db.run(...arguments, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });
    }

    close() {
        return new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

module.exports = new Database();