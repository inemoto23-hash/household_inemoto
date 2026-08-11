/**
 * エントリポイント。
 * ここで読み込んだモジュールが app.http(...) を呼ぶことで関数が登録される。
 * 新しいエンドポイントを追加したら、必ずこのファイルに import を足すこと。
 */
import './functions/health';
import './functions/bootstrap';
import './functions/members';
import './functions/avatar';
import './functions/accounts';
import './functions/master';
import './functions/entries';
import './functions/stock';
import './functions/budgets';
import './functions/periods';
import './functions/analytics';
import './functions/schedules';
import './functions/reminders';
