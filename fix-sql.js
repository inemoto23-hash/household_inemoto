// PostgreSQL対応のためにSQL文を修正するスクリプト
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
let content = fs.readFileSync(serverPath, 'utf8');

// strftime('%Y-%m', t.date) を ${getYearMonthFormat('t.date')} に置換
content = content.replace(/strftime\('%Y-%m',\s*t\.date\)/g, "${getYearMonthFormat('t.date')}");
content = content.replace(/strftime\("%Y-%m",\s*t\.date\)/g, "${getYearMonthFormat('t.date')}");

// strftime('%Y', t.date) を ${getYearFormat('t.date')} に置換
content = content.replace(/strftime\('%Y',\s*t\.date\)/g, "${getYearFormat('t.date')}");
content = content.replace(/strftime\("%Y",\s*t\.date\)/g, "${getYearFormat('t.date')}");

// strftime('%m', t.date) を ${getMonthFormat('t.date')} に置換
content = content.replace(/strftime\('%m',\s*t\.date\)/g, "${getMonthFormat('t.date')}");
content = content.replace(/strftime\("%m",\s*t\.date\)/g, "${getMonthFormat('t.date')}");

fs.writeFileSync(serverPath, content, 'utf8');
console.log('✅ SQL文の修正が完了しました');
