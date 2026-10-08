import { Router } from "express";
import { pool } from "../db.js";
import { requireOrgRole } from "../lib/orgAccess.js";
import { applyPayment, applyMarkSeen, applySnooze } from "../lib/kitActions.js";
import { answerCallbackQuery, editMessage } from "../lib/telegram.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { telegramConfigured, resolveChatId } from "../lib/telegram.js";

const router = Router();
// The callback webhook is mounted BEFORE requireAuth, because the
// caller is Telegram's servers, not a browser with a session. It
// authenticates entirely differently - see the notes on the route
// itself.
router.post("/webhook", handleWebhook);

router.use(requireAuth);

// Lets the frontend know whether it should even show the Telegram section
// (server-wide bot configured) and whether alerts are actually ready to
// send for this user (bot + a chat ID from either the env override or
// their own saved value), without leaking the token itself.
router.get("/status", async (req, res) => {
  const { rows } = await pool.query(`SELECT telegram_chat_id FROM users WHERE id = $1`, [req.userId]);
  const chatId = resolveChatId(rows[0]);
  res.json({
    configured: telegramConfigured(),
    ready: telegramConfigured() && !!chatId,
    source: !chatId ? null : process.env.TELEGRAM_CHAT_ID ? "env" : "user",
  });
});

export default router;


// ===================================================================
// Inline button callbacks
// ===================================================================

// Telegram POSTs here whenever someone taps a button on an alert.
//
// Three independent checks before anything is written, because this
// endpoint is public by necessity and a forged request would otherwise
// be able to mark any kit as paid:
//
//   1. The secret token header. Telegram echoes back the value
//      registered with setWebhook, and it's the only thing proving the
//      request came from Telegram at all.
//   2. The chat the tap came from must resolve to a user of this
//      instance - either the deployment-wide TELEGRAM_CHAT_ID or a
//      specific account's linked chat.
//   3. That user must actually be allowed to manage the kit named in
//      the callback, checked exactly the same way the app checks it.
//
// The third is the one that matters most: without it, anyone in a shared
// alert chat could act on every kit in the instance regardless of which
// organization they belong to.
async function handleWebhook(req, res) {
  // Always 200. Telegram retries on any non-2xx, so returning an error
  // for a request we've deliberately rejected just invites it to be
  // replayed repeatedly.
  const ack = () => res.status(200).json({ ok: true });

  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || req.headers["x-telegram-bot-api-secret-token"] !== expected) {
    console.warn("Rejected a Telegram webhook call with a bad or missing secret token");
    return ack();
  }

  const callback = req.body?.callback_query;
  if (!callback) return ack();

  const [action, kitId] = String(callback.data || "").split(":");
  const chatId = String(callback.message?.chat?.id ?? "");
  if (!action || !kitId || !chatId) return ack();

  try {
    const user = await userForChat(chatId);
    if (!user) {
      await answerCallbackQuery(callback.id, "This chat isn't linked to an account.");
      return ack();
    }

    const { rows } = await pool.query(
      `SELECT * FROM kits WHERE id = $1
         AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`,
      [kitId, user.id]
    );
    const kit = rows[0];
    if (!kit) {
      await answerCallbackQuery(callback.id, "That kit is gone, or isn't yours.");
      return ack();
    }
    const isCreator = kit.user_id === user.id;
    const isOrgAdmin = kit.organization_id && (await requireOrgRole(user.id, kit.organization_id, "admin"));
    if (!isCreator && !isOrgAdmin) {
      await answerCallbackQuery(callback.id, "You can see this kit but can't change it.");
      return ack();
    }

    const outcome = await runTelegramAction(action, kit, user);
    await answerCallbackQuery(callback.id, outcome.toast);
    await editMessage({
      chatId,
      messageId: callback.message.message_id,
      // The original text is kept and the outcome appended, so the chat
      // stays a readable history of what happened rather than a list of
      // bare confirmations with no context.
      text: `${callback.message.text}\n\n✅ ${outcome.note}`,
    });
  } catch (err) {
    console.error("Telegram callback failed:", err.message);
    await answerCallbackQuery(callback.id, "Something went wrong - try the app.");
  }
  return ack();
}

// A deployment-wide TELEGRAM_CHAT_ID wins, matching how resolveChatId
// picks a destination when sending - so the same chat that receives the
// alerts is the one that can act on them.
async function userForChat(chatId) {
  if (process.env.TELEGRAM_CHAT_ID && String(process.env.TELEGRAM_CHAT_ID) === chatId) {
    const { rows } = await pool.query(`SELECT * FROM users ORDER BY created_at ASC LIMIT 1`);
    return rows[0] || null;
  }
  const { rows } = await pool.query(`SELECT * FROM users WHERE telegram_chat_id = $1`, [chatId]);
  return rows[0] || null;
}

async function runTelegramAction(action, kit, user) {
  switch (action) {
    case "paid": {
      const result = await applyPayment(kit, { method: "recorded from Telegram", via: "Telegram" }, user.id);
      const amount = result.amount ? `${result.currency} ${result.amount}` : "Payment";
      return {
        toast: `${amount} recorded`,
        note: `${amount} recorded by ${user.email}. Next due ${result.nextDue.toISOString().slice(0, 10)}.`,
      };
    }
    case "seen":
      await applyMarkSeen(kit, { via: "Telegram" }, user.id);
      return { toast: "Marked as in use", note: `Marked as in use by ${user.email}.` };
    case "snooze":
      await applySnooze(kit, 3 * 24 * 60, user.id, "Telegram");
      return { toast: "Muted for 3 days", note: `Alerts muted for 3 days by ${user.email}.` };
    default:
      return { toast: "Unknown action", note: "Unrecognised action." };
  }
}
