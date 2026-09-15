import webpush from "web-push";
import { pool } from "../db.js";

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
  return true;
}

export async function sendPushToUser(userId, payload) {
  if (!ensureConfigured()) return { total: 0, sent: 0, failed: 0, configured: false };
  const { rows } = await pool.query(`SELECT * FROM push_subscriptions WHERE user_id = $1`, [userId]);
  let sent = 0;
  let failed = 0;
  await Promise.all(
    rows.map(async (sub) => {
      const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        sent++;
      } catch (err) {
        failed++;
        // 410/404 means the browser unsubscribed or the endpoint expired.
        // clean it up so future ticks don't keep retrying a dead endpoint -
        // this is also the single most common reason a subscription that
        // "used to work" silently stops: the OS/browser dropped it on its
        // own (long idle period, app reinstall, etc.) with no way for us
        // to know except the next failed send.
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
        } else {
          console.error("Push send failed:", err.message);
        }
      }
    })
  );
  return { total: rows.length, sent, failed, configured: true };
}
