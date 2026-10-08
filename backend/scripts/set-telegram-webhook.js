import "dotenv/config";
import { setWebhook } from "../src/lib/telegram.js";

// Registers this deployment's callback URL with Telegram, so tapping a
// button on an alert reaches the backend. Run once per deployment, and
// again whenever the backend URL changes.
//
//   npm run telegram-webhook
//
// Needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and BACKEND_URL in
// the environment. The secret is what the webhook checks on every
// incoming call - without it every callback is refused, which is the
// safe default rather than an open endpoint.
const backend = process.env.BACKEND_URL;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!backend || !secret) {
  console.error("Set BACKEND_URL (e.g. https://your-app.onrender.com) and TELEGRAM_WEBHOOK_SECRET first.");
  process.exit(1);
}

const url = `${backend.replace(/\/$/, "")}/api/telegram/webhook`;
const result = await setWebhook(url, secret);
if (result.ok) {
  console.log(`Telegram will now send button taps to ${url}`);
} else {
  console.error("Failed to register the webhook:", result.description || "unknown error");
  process.exit(1);
}
