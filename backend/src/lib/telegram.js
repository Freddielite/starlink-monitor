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

// `buttons` is an optional array of { label, action, kitId } that turns
// an alert into something actionable from the notification itself.
// Telegram caps callback_data at 64 bytes, which a "verb:uuid" pair fits
// inside with room to spare - anything longer would have to be stored
// server-side and referenced by a token, which isn't worth it for the
// three verbs here.
export function kitActionKeyboard(kitId, actions) {
  return {
    inline_keyboard: [
      actions.map((a) => ({ text: a.label, callback_data: `${a.action}:${kitId}` })),
    ],
  };
}

export async function sendTelegramMessage({ chatId, text, replyMarkup = null }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { sent: false, reason: "Telegram bot not configured" };
  if (!chatId) return { sent: false, reason: "no chat id" };

  try {
    const response = await fetch(`${API_ROOT}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
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

// Telegram expects every callback_query to be acknowledged, and shows a
// spinner on the button until it is. The optional text surfaces as a
// toast inside the chat, which is how the user learns the tap worked
// without the message itself having to change.
export async function answerCallbackQuery(callbackQueryId, text = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`${API_ROOT}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text, show_alert: false } : {}) }),
  }).catch((err) => console.error("answerCallbackQuery failed:", err.message));
}

// Rewrites the original alert in place once it's been acted on, and
// drops its buttons. Without this the message keeps offering "Mark paid"
// on a kit that's already paid, and a second tap later would record a
// duplicate payment - the message is a piece of UI that has to reflect
// state, not a log line.
export async function editMessage({ chatId, messageId, text }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId || !messageId) return;
  await fetch(`${API_ROOT}/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }),
  }).catch((err) => console.error("editMessageText failed:", err.message));
}

// Registers this deployment's callback URL with Telegram. Called from
// the setup script rather than at boot: re-registering on every restart
// would hammer their API for no reason, and the URL only changes when
// the deployment does.
export async function setWebhook(url, secretToken) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, reason: "TELEGRAM_BOT_TOKEN not set" };
  const response = await fetch(`${API_ROOT}/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secretToken,
      // Only the two update kinds this app reacts to. Narrowing it keeps
      // unrelated traffic (group joins, edits, channel posts) from
      // reaching the endpoint at all.
      allowed_updates: ["callback_query", "message"],
    }),
  });
  const body = await response.json().catch(() => null);
  return { ok: !!body?.ok, description: body?.description };
}
