// Brevo's transactional email HTTP API, not SMTP - this app used to send
// mail over nodemailer/SMTP, but that stopped working the moment it was
// deployed to a free Render web service: Render blocks all outbound
// traffic on SMTP ports (25, 465, 587) on free instances (as of Sept
// 2025) to fight spam abuse, so nodemailer's connection attempt just
// hung until it timed out - completely independent of whether the SMTP
// credentials themselves were right. Every request over this API is a
// plain HTTPS POST on port 443, which isn't part of that block, so it
// works on a free instance exactly as well as a paid one.
//
// Same reasoning as lib/telegram.js and lib/webhook.js: one plain
// fetch rather than a provider SDK, since a POST and a JSON body is
// the entire integration surface here.

const API_ROOT = "https://api.brevo.com/v3/smtp/email";
const REQUEST_TIMEOUT_MS = 10000;

export async function sendAlertEmail({ to, subject, text, actionUrl, actionLabel }) {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.EMAIL_FROM;
  if (!apiKey || !fromEmail) return { sent: false, reason: "Brevo not configured" };
  if (!to) return { sent: false, reason: "no recipient" };

  const payload = {
    sender: { email: fromEmail, name: process.env.EMAIL_FROM_NAME || "Starlink Monitor" },
    to: [{ email: to }],
    subject,
    textContent: text,
  };
  // Optional - most alerts (down/degraded/security) are just informing
  // someone of a fact, with nothing to click. actionUrl/actionLabel are
  // for the handful that ARE actionable (an org invite: "join now"), so
  // that one gets an actual styled button instead of a bare pasted URL
  // buried in a paragraph. htmlContent and textContent aren't
  // alternatives to each other in this API - most mail clients render
  // whichever they support and fall back to the other, so both get
  // sent whenever there's a link, keeping the plain-text version (with
  // the raw URL spelled out) as the fallback for clients that don't
  // render HTML.
  if (actionUrl) {
    payload.htmlContent = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1f1c;max-width:480px">
      <p>${escapeHtml(text)}</p>
      <p style="margin:24px 0;text-align:center">
        <a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#4db5ff;color:#0a0e14;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:6px">${escapeHtml(actionLabel || "Open Starlink Monitor")}</a>
      </p>
      <p style="color:#8b96a3;font-size:12.5px">If the button doesn't work, copy this link: ${escapeHtml(actionUrl)}</p>
    </div>`;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(API_ROOT, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`Failed to send alert email: Brevo returned ${response.status} ${body.slice(0, 200)}`);
      return { sent: false, reason: `Brevo returned ${response.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("Failed to send alert email:", err.message);
    return { sent: false, reason: err.message };
  }
}

function escapeHtml(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}
