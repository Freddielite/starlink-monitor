// Address -> lat/lng via Nominatim (OpenStreetMap's own geocoder). Free,
// no API key, no billing account, which is the entire reason it's here
// rather than Google's Geocoding API - the map stack for this app is
// Leaflet + OSM tiles + Nominatim precisely so it can't accumulate a
// bill or a key to rotate.
//
// The cost of that is real and worth stating plainly rather than
// discovering later: Nominatim's usage policy caps this at roughly one
// request per second with a genuine identifying User-Agent, and its
// coverage of informal or non-standard addresses is noticeably weaker
// than a commercial geocoder's. For a Nigerian address like "3rd floor,
// opposite the filling station, Ago Palace Way" it will often return
// either nothing or the centroid of the wider area with high confidence.
// That's why every geocode result in this app is a SUGGESTION the user
// confirms into the lat/lng fields, never something written silently to
// the kit, and why manual lat/lng entry is a first-class path rather
// than a fallback nobody can find - see routes/kits.js and KitForm.jsx.

const API_ROOT = "https://nominatim.openstreetmap.org/search";
const REQUEST_TIMEOUT_MS = 10000;
// Nominatim's policy is a hard limit, not a suggestion - exceeding it
// gets an IP blocked, and a blocked IP takes the feature away from every
// user of this deployment at once. One in-process gate, applied to every
// call, is the cheapest way to make that impossible to trip by accident.
// This is process-local, so it does NOT coordinate across multiple
// backend instances; a single free-tier web service is one process, and
// if this is ever scaled out this needs to become a database-backed
// token bucket.
const MIN_INTERVAL_MS = 1100;

let lastRequestAt = 0;
let queue = Promise.resolve();

function throttle(fn) {
  // Chaining onto a shared promise rather than a bare timestamp check
  // means two concurrent callers queue behind each other instead of both
  // seeing the same stale lastRequestAt and firing together.
  const run = queue.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if this call rejects, otherwise one
  // failure poisons every subsequent geocode for the process lifetime.
  queue = run.catch(() => {});
  return run;
}

// A contact address in the User-Agent is required by Nominatim's usage
// policy. Falls back to something identifying-but-generic rather than
// refusing to run, since a missing env var shouldn't take the feature
// out entirely - but it's worth setting, because an anonymous heavy user
// is the one most likely to get blocked.
function userAgent() {
  const contact = process.env.NOMINATIM_CONTACT_EMAIL;
  return `StarlinkMonitor/1.0${contact ? ` (${contact})` : ""}`;
}

export function buildQuery({ address, city, region, country }) {
  return [address, city, region, country].map((p) => p?.trim()).filter(Boolean).join(", ");
}

// Returns { results: [...] } with up to `limit` candidates, or
// { results: [], reason } when the lookup itself failed. A failed lookup
// and a lookup that found nothing are returned as different things on
// purpose: "we couldn't reach the geocoder" and "this address doesn't
// exist as far as OSM knows" call for different reactions from the
// person typing, and collapsing them into an empty list would tell them
// the wrong one half the time.
export async function geocodeAddress(parts, { limit = 5 } = {}) {
  const q = buildQuery(parts);
  if (!q) return { results: [], reason: "nothing to geocode" };

  try {
    const response = await throttle(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const url = `${API_ROOT}?format=jsonv2&addressdetails=1&limit=${limit}&q=${encodeURIComponent(q)}`;
      return fetch(url, {
        headers: { "User-Agent": userAgent(), Accept: "application/json" },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    });

    if (!response.ok) {
      return { results: [], reason: `the geocoder returned ${response.status}` };
    }
    const body = await response.json();
    if (!Array.isArray(body)) return { results: [], reason: "unexpected response from the geocoder" };

    return {
      results: body.map((row) => ({
        label: row.display_name,
        latitude: Number(row.lat),
        longitude: Number(row.lon),
        // Nominatim's own confidence-ish score. Surfaced rather than
        // hidden because it's the main signal available for "this looks
        // like a guess" on the informal addresses this is weakest at.
        importance: row.importance ?? null,
        type: row.type || row.category || null,
        city: row.address?.city || row.address?.town || row.address?.village || row.address?.suburb || null,
        region: row.address?.state || row.address?.region || null,
        country: row.address?.country || null,
      })),
    };
  } catch (err) {
    return { results: [], reason: err.name === "AbortError" ? "the geocoder timed out" : err.message };
  }
}

// Bounds check for hand-entered coordinates. Exists because the single
// most common manual-entry mistake is swapping lat and lng, and for a
// lot of the world (including everywhere within ~90 degrees of the
// equator) the swapped pair is still numerically valid - it just puts
// the pin in the wrong hemisphere with no error. This can't catch that,
// but it does catch the out-of-range half, and the map preview in the
// form is what catches the rest.
export function validateCoords(lat, lng) {
  if (lat === null && lng === null) return null;
  if (lat === null || lng === null) return "latitude and longitude have to be set together, or both left blank";
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return "latitude has to be a number between -90 and 90";
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return "longitude has to be a number between -180 and 180";
  return null;
}
