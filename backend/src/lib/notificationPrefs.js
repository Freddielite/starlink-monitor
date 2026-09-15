// Single source of truth for the notification_prefs shape (see the
// column comment in db.js). Every caller that decides whether to fire a
// push, Telegram, or webhook send goes through wantsNotification()
// rather than reading user.notification_prefs directly, so a missing key
// (an account created before a given event kind existed, or a client
// that only ever sent one channel) always falls back to "on" instead of
// silently reading as opted out.
//
// The five event keys are the five things a sweep can decide to wake
// someone up about, one per axis except billing which has three
// (approaching, overdue-but-in-grace, suspended) because in practice
// people want those on different channels: a due-date nudge is an email,
// a suspension is a push.

export const DEFAULT_NOTIFICATION_PREFS = {
  push: { expiring: true, grace: true, suspended: true, hardware: true, idle: true },
  telegram: { expiring: true, grace: true, suspended: true, hardware: true, idle: true },
  webhook: { expiring: true, grace: true, suspended: true, hardware: true, idle: true },
};

export const EVENT_LABELS = {
  expiring: "Expiring soon",
  grace: "Grace period",
  suspended: "Suspension",
  hardware: "Hardware down / back",
  idle: "Idle kits",
};

const EVENT_KEYS = Object.keys(DEFAULT_NOTIFICATION_PREFS.push);
const CHANNELS = ["push", "telegram", "webhook"];

export function wantsNotification(user, channel, eventKey) {
  const value = user?.notification_prefs?.[channel]?.[eventKey];
  return typeof value === "boolean" ? value : DEFAULT_NOTIFICATION_PREFS[channel]?.[eventKey] ?? true;
}

// Merges whatever the client sent onto the full default shape, so a
// PATCH that only tweaks one checkbox can't accidentally wipe the rest
// to "undefined" (which JSONB stores as literally missing, and the very
// code this feeds treats that as "on" - two defaults disagreeing would
// be worse than either alone).
export function normalizeNotificationPrefs(input) {
  const out = {
    push: { ...DEFAULT_NOTIFICATION_PREFS.push },
    telegram: { ...DEFAULT_NOTIFICATION_PREFS.telegram },
    webhook: { ...DEFAULT_NOTIFICATION_PREFS.webhook },
  };
  for (const channel of CHANNELS) {
    const incoming = input?.[channel];
    if (incoming && typeof incoming === "object") {
      for (const key of EVENT_KEYS) {
        if (typeof incoming[key] === "boolean") out[channel][key] = incoming[key];
      }
    }
  }
  return out;
}
