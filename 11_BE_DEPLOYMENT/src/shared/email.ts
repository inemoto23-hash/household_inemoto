/**
 * メール送信（Azure Communication Services）。
 *
 * 接続文字列もアクセスキーも持たない。マネージドIDで取得したトークンだけで送る。
 *
 * SDK を入れず REST を直接叩いているのは、送信が1種類しかなく、
 * 依存を1つ増やすほどの内容が無いため。
 */
import { DefaultAzureCredential } from '@azure/identity';

const ACS_SCOPE = 'https://communication.azure.com/.default';
/** 期限のこれだけ手前で取り直す（ミリ秒） */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** 送信要求のタイムアウト。ここで詰まらせない */
const TIMEOUT_MS = 20_000;

const credential = new DefaultAzureCredential();
let cachedToken: { value: string; expiresOn: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresOn - REFRESH_MARGIN_MS) {
    return cachedToken.value;
  }
  const token = await credential.getToken(ACS_SCOPE);
  if (!token) throw new Error('ACS のアクセストークンを取得できませんでした');
  cachedToken = { value: token.token, expiresOn: token.expiresOnTimestamp };
  return token.token;
}

export function isEmailConfigured(): boolean {
  return !!process.env.ACS_ENDPOINT && !!process.env.ACS_SENDER;
}

export interface MailInput {
  to: { address: string; displayName?: string }[];
  subject: string;
  /** 素のテキスト。HTML を持たないメールでも読めるようにする */
  text: string;
  html?: string;
}

/**
 * 送信する。宛先が空なら何もしない。
 * 例外はそのまま投げる。呼び出し側で失敗回数を数えるため。
 */
export async function sendMail(input: MailInput): Promise<void> {
  if (input.to.length === 0) return;

  const endpoint = process.env.ACS_ENDPOINT;
  const sender = process.env.ACS_SENDER;
  if (!endpoint || !sender) throw new Error('ACS_ENDPOINT / ACS_SENDER が設定されていません');

  const token = await getToken();
  const url = `${endpoint.replace(/\/$/, '')}/emails:send?api-version=2023-03-31`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        senderAddress: sender,
        content: {
          subject: input.subject,
          plainText: input.text,
          ...(input.html ? { html: input.html } : {}),
        },
        recipients: { to: input.to },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`ACS ${response.status}: ${body.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
