import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { telegramConfigured, resolveChatId } from "../lib/telegram.js";

const router = Router();
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
