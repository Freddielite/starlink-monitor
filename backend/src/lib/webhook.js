// Generic outbound webhook alert - Slack, Discord, PagerDuty (via its
// Events API v2 custom integration), Opsgenie, or any URL that accepts a
// JSON POST. Deliberately one plain fetch rather than a per-provider
// SDK, same reasoning as lib/telegram.js: a small amount of obvious
// code, and the providers' real SDKs mostly exist for features (OAuth,
// rich interactive blocks) this doesn't need.
//
// The payload is a flat, provider-agnostic shape rather than, say,
// Slack's specific `blocks` format. Most receiving services (Slack
// included) will happily accept a plain JSON body with a `text` field
// even without speaking their native format, and anyone who wants
// richer formatting for their specific provider can transform this on
// their own receiving end (a Zapier/Make step, a tiny relay function)
// without Starlink Monitor needing to know about every provider individually.

import { assertPublicHttpUrl } from "./urlSafety.js";

const REQUEST_TIMEOUT_MS = 8000;

export async function sendWebhookAlert(url, { event, severity = null, title, body = "", kit = null }) {
  if (!url) return { sent: false, reason: "no webhook url configured" };

  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    console.error(`Webhook URL rejected for "${event}": ${err.message}`);
    return { sent: false, reason: err.message };
  }

  const payload = {
    event,
    severity,
    title,
    text: body ? `${title}\n${body}` : title,
    // A flat subset rather than the whole row: the receiving end wants
    // enough to route and label the alert, not a dump of every column
    // (including the agent token hash, which must never leave here).
    kit: kit
      ? {
          id: kit.id,
          name: kit.name,
          client: kit.client_name || null,
          city: kit.city || null,
          region: kit.region || null,
          billing_state: kit.billing_state,
          hardware_state: kit.hardware_state,
          next_due_at: kit.next_due_at,
        }
      : null,
    sent_at: new Date().toISOString(),
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      console.error(`Webhook for "${event}" returned ${response.status}`);
      return { sent: false, reason: `webhook returned ${response.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("Failed to send webhook:", err.message);
    return { sent: false, reason: err.message };
  }
}
