export const BASE = import.meta.env.VITE_API_URL || "/api";

async function apiFetch(path, options = {}) {
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      ...fetchOptions,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out. Check your connection and try again.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      // response wasn't JSON, keep the generic message
    }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const signup = (payload) => apiFetch("/auth/signup", { method: "POST", body: JSON.stringify(payload) });
export const verifyEmail = (token) => apiFetch("/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });
export const login = (payload) => apiFetch("/auth/login", { method: "POST", body: JSON.stringify(payload) });
export const logout = () => apiFetch("/auth/logout", { method: "POST" });
export const getMe = () => apiFetch("/auth/me");
export const updateMe = (payload) => apiFetch("/auth/me", { method: "PATCH", body: JSON.stringify(payload) });
export const changePassword = (payload) => apiFetch("/auth/change-password", { method: "POST", body: JSON.stringify(payload) });
export const verifyLoginTotp = (payload) => apiFetch("/auth/2fa/verify-login", { method: "POST", body: JSON.stringify(payload) });
export const setup2fa = () => apiFetch("/auth/2fa/setup", { method: "POST" });
export const confirm2fa = (code) => apiFetch("/auth/2fa/confirm", { method: "POST", body: JSON.stringify({ code }) });
export const disable2fa = (password) => apiFetch("/auth/2fa/disable", { method: "POST", body: JSON.stringify({ password }) });
export const testWebhook = () => apiFetch("/auth/webhook-test", { method: "POST" });

export const listKits = () => apiFetch("/kits");
export const getKit = (id) => apiFetch(`/kits/${id}`);
export const createKit = (payload) => apiFetch("/kits", { method: "POST", body: JSON.stringify(payload) });
export const updateKit = (id, payload) => apiFetch(`/kits/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const deleteKit = (id) => apiFetch(`/kits/${id}`, { method: "DELETE" });
export const refreshKits = () => apiFetch("/kits/refresh", { method: "POST", timeoutMs: 40000 });

export const listPayments = (id) => apiFetch(`/kits/${id}/payments`);
export const recordPayment = (id, payload) => apiFetch(`/kits/${id}/payments`, { method: "POST", body: JSON.stringify(payload) });
export const deletePayment = (id, paymentId) => apiFetch(`/kits/${id}/payments/${paymentId}`, { method: "DELETE" });

export const setBillingState = (id, state, note) =>
  apiFetch(`/kits/${id}/billing-state`, { method: "POST", body: JSON.stringify({ state, note }) });
export const setHardwareState = (id, state, note) =>
  apiFetch(`/kits/${id}/hardware-state`, { method: "POST", body: JSON.stringify({ state, note }) });
export const markSeen = (id, payload = {}) => apiFetch(`/kits/${id}/seen`, { method: "POST", body: JSON.stringify(payload) });

export const snoozeKit = (id, minutes) => apiFetch(`/kits/${id}/snooze`, { method: "POST", body: JSON.stringify({ minutes }) });
export const unsnoozeKit = (id) => apiFetch(`/kits/${id}/unsnooze`, { method: "POST" });

export const getKitEvents = (id, limit = 60) => apiFetch(`/kits/${id}/events?limit=${limit}`);
export const getKitHeartbeats = (id, limit = 200) => apiFetch(`/kits/${id}/heartbeats?limit=${limit}`);

export const issueAgentToken = (id) => apiFetch(`/kits/${id}/agent/token`, { method: "POST" });
export const disableAgent = (id) => apiFetch(`/kits/${id}/agent`, { method: "DELETE" });

// Nominatim is rate-limited server-side to roughly one request a second
// (see backend lib/geocode.js), so a queued lookup can genuinely take a
// few seconds before it even leaves the building. A longer timeout here
// than a normal read, otherwise the client gives up on a request that
// was only ever waiting its turn.
export const geocode = (payload) => apiFetch("/kits/geocode", { method: "POST", body: JSON.stringify(payload), timeoutMs: 30000 });

export const getVapidPublicKey = () => apiFetch("/push/vapid-public-key");
export const subscribePush = (subscription) => apiFetch("/push/subscribe", { method: "POST", body: JSON.stringify(subscription) });
export const unsubscribePush = (endpoint) => apiFetch("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });

export const getTelegramStatus = () => apiFetch("/telegram/status");

export const listApiTokens = () => apiFetch("/tokens");
export const createApiToken = (name) => apiFetch("/tokens", { method: "POST", body: JSON.stringify({ name }) });
export const deleteApiToken = (id) => apiFetch(`/tokens/${id}`, { method: "DELETE" });

export const listOrganizations = () => apiFetch("/organizations");
export const createOrganization = (name) => apiFetch("/organizations", { method: "POST", body: JSON.stringify({ name }) });
export const getOrganization = (id) => apiFetch(`/organizations/${id}`);
export const updateOrganization = (id, payload) => apiFetch(`/organizations/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const deleteOrganization = (id) => apiFetch(`/organizations/${id}`, { method: "DELETE" });
export const inviteOrgMember = (id, email, role) => apiFetch(`/organizations/${id}/invite`, { method: "POST", body: JSON.stringify({ email, role }) });
export const updateOrgMemberRole = (id, memberId, role) => apiFetch(`/organizations/${id}/members/${memberId}`, { method: "PATCH", body: JSON.stringify({ role }) });
export const removeOrgMember = (id, memberId) => apiFetch(`/organizations/${id}/members/${memberId}`, { method: "DELETE" });
