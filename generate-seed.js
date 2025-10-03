const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database', 'household_budget.db');
const db = new sqlite3.Database(dbPath);

async function generateSeedFile() {
    console.log('データベースからデータを取得中...');

    const tables = ['expense_categories', 'wallet_categories', 'credit_categories', 'monthly_budgets', 'transactions', 'monthly_credit_summary'];
    const allData = {};

    for (const table of tables) {
        await new Promise((resolve, reject) => {
            db.all(`SELECT * FROM ${table}`, (err, rows) => {
                if (err) {
                    console.error(`Error fetching ${table}:`, err);
                    allData[table] = [];
                } else {
                    allData[table] = rows;
                    console.log(`${table}: ${rows.length}件`);
                }
                resolve();
            });
        });
    }

    // SQLステートメントを生成
    let migrationStatements = [];

    for (const table of tables) {
        const rows = allData[table];
        for (const row of rows) {
            const columns = Object.keys(row).join(', ');
            const values = Object.values(row).map(val => {
                if (val === null) return 'NULL';
                if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
                return val;
            }).join(', ');

            migrationStatements.push(`"INSERT INTO ${table} (${columns}) VALUES (${values})"`);
        }
    }

    // seed.jsファイルを生成
    const seedTemplate = `const fs = require('fs');
const path = require('path');

// 初期データを投入する関数
async function seedDatabase(db) {
    console.log('データベースにデータを投入中...');

    try {
        const migrationStatements = [
${migrationStatements.map(s => '            ' + s).join(',\n')}
        ];

        console.log(\`\${migrationStatements.length}件のデータを投入中...\`);

        for (const statement of migrationStatements) {
            try {
                await db.run(statement);
            } catch (err) {
                console.warn('データ投入スキップ:', err.message);
            }
        }

        console.log('✅ データの投入が完了しました！');
        console.log('- 出費カテゴリ: ${allData.expense_categories.length}件');
        console.log('- 財布カテゴリ: ${allData.wallet_categories.length}件');
        console.log('- 取引データ: ${allData.transactions.length}件');
        console.log('- 予算設定: ${allData.monthly_budgets.length}件');
        console.log('- クレジット集計: ${allData.monthly_credit_summary.length}件');

    } catch (error) {
        console.error('データ投入エラー:', error);
        throw error;
    }
}

module.exports = { seedDatabase };
`;

    const outputPath = path.join(__dirname, 'database', 'seed.js');
    fs.writeFileSync(outputPath, seedTemplate, 'utf8');
    console.log(`\n✅ seed.jsを生成しました: ${outputPath}`);
    console.log(`総データ数: ${migrationStatements.length}件`);

    db.close();
}

generateSeedFile().catch(console.error);
