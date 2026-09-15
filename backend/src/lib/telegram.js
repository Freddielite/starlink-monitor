// One bot for the whole app, configured server-wide via TELEGRAM_BOT_TOKEN
// (same shape as SMTP_* for email: one set of send credentials, a
// destination on top). The destination itself can come from either
// place:
//   - TELEGRAM_CHAT_ID env var - a single hardcoded chat, set once in
//     Render/wherever and shared by the whole deployment. Simplest path
//     for a single-user instance, and deliberately wins if set, so
//     switching an instance over to it doesn't require also clearing out
//     old per-user values in the database.
//   - users.telegram_chat_id - per-user, for deployments with more than
//     one account where a single shared chat ID would cross wires
//     between users' alerts.
const API_ROOT = "https://api.telegram.org";

export function telegramConfigured() {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

// `user` is optional - callers that only have the env var in play (e.g.
// checking readiness before a user is loaded) can omit it.
export function resolveChatId(user) {
  return process.env.TELEGRAM_CHAT_ID || user?.telegram_chat_id || null;
}

export async function sendTelegramMessage({ chatId, text }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { sent: false, reason: "Telegram bot not configured" };
  if (!chatId) return { sent: false, reason: "no chat id" };

  try {
    const response = await fetch(`${API_ROOT}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const reason = body?.description || `Telegram API returned ${response.status}`;
      console.error("Failed to send Telegram message:", reason);
      return { sent: false, reason };
    }
    return { sent: true };
  } catch (err) {
    console.error("Failed to send Telegram message:", err.message);
    return { sent: false, reason: err.message };
  }
}
