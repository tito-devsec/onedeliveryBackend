/**
 * Google Maps Platform, called from the server only so the key never ships in the apps.
 *  • Routes API             — road routes (distance, duration, polyline)
 *  • Places API (New)       — address search (autocomplete + place details)
 *  • Geocoding API          — coordinates → address
 * The legacy Directions / Places web services can't be enabled on new Google Cloud
 * projects, so they are not used. Results are cached in Redis to keep the bill small,
 * and each service stops just under Google's free monthly allowance (see `allow`).
 */
import { ENV } from "../config/env.js";
import { cacheGet, cacheSet, getRedis } from "../config/redis.js";

const ROUTES_URL       = "https://routes.googleapis.com/directions/v2:computeRoutes";
const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const PLACE_URL        = "https://places.googleapis.com/v1/places/";
const GEOCODE_URL      = "https://maps.googleapis.com/maps/api/geocode/json";

// Dar es Salaam city centre: where searches are biased when the phone gives no location
export const DEFAULT_CENTER = { lat: -6.7924, lng: 39.2083 };

export const mapsEnabled = () => !!ENV.GOOGLE_MAPS_API_KEY;

const r4 = (n) => Number(n).toFixed(4); // ~11 m: close enough to share a cached result

async function google(url, { method = "GET", body, fieldMask, timeoutMs = 8000 } = {}) {
  const headers = { "X-Goog-Api-Key": ENV.GOOGLE_MAPS_API_KEY };
  if (fieldMask) headers["X-Goog-FieldMask"] = fieldMask;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${res.status}: ${json?.error?.message || res.statusText}`);
  return json;
}

// ── Free monthly allowance ────────────────────────────────────────────────────
// Google gives Routes, Place Details, Geocoding and Autocomplete 10,000 free calls a
// month each (live-traffic routes: 5,000). The server counts its own calls and stops
// at MAPS_MONTHLY_LIMIT (default 9,500); after that the apps use straight-line
// distances and estimated times until the month turns. 0 = no limit.
const monthKey = (service) => `maps:usage:${service}:${new Date().toISOString().slice(0, 7)}`;

function monthlyLimit(service) {
  const limit = ENV.MAPS_MONTHLY_LIMIT;
  if (!limit) return 0;
  return service === "routes" && ENV.MAPS_TRAFFIC_AWARE ? Math.floor(limit / 2) : limit;
}

async function allow(service) {
  const limit = monthlyLimit(service);
  if (!limit) return true;
  try {
    const r = getRedis();
    const key = monthKey(service);
    const used = await r.incr(key);
    if (used === 1) await r.expire(key, 40 * 24 * 3600);
    if (used <= limit) return true;
    if (used === limit + 1) console.warn(`[maps] ${service}: free monthly allowance used (${limit}) — estimates until next month`);
    return false;
  } catch {
    return true; // Redis down: don't take maps away
  }
}

// Requests Google rejects (e.g. billing not active yet, quota or server errors) aren't
// billed, so they shouldn't use up the free allowance either
async function refund(service) {
  if (!monthlyLimit(service)) return;
  try { await getRedis().decr(monthKey(service)); } catch { /* non-critical */ }
}

// Autocomplete keystrokes are free when the search ends with a place being picked
// (Google bills them as "session usage"), so they come off the count at that point.
const sessionKey = (token) => `maps:ac:session:${token}`;

async function noteSearch(token) {
  try {
    const r = getRedis();
    await r.incr(sessionKey(token));
    await r.expire(sessionKey(token), 600);
  } catch { /* non-critical */ }
}

async function settleSearch(token) {
  try {
    const r = getRedis();
    const n = parseInt(await r.get(sessionKey(token)), 10);
    if (!n) return;
    await r.del(sessionKey(token));
    await r.decrby(monthKey("autocomplete"), n);
  } catch { /* non-critical */ }
}

// This month's Google calls per service (for logs / admin): calls made, and calls
// refused because the free allowance was used up
export async function mapsUsage() {
  const out = {};
  for (const s of ["routes", "details", "geocode", "autocomplete"]) {
    const attempts = parseInt(await getRedis().get(monthKey(s)).catch(() => 0), 10) || 0;
    const limit = monthlyLimit(s);
    out[s] = limit
      ? { calls: Math.min(attempts, limit), refused: Math.max(0, attempts - limit), limit }
      : { calls: attempts, refused: 0, limit: null };
  }
  return out;
}

// ── Road route A → B ──────────────────────────────────────────────────────────
// Returns { distanceMeters, durationSeconds, polyline } or null when unavailable;
// with `steps`, also the turn-by-turn steps for driver navigation (still the
// Essentials price: only live traffic, 10+ waypoints or two-wheeler mode cost more).
// Live traffic (Routes "Pro" pricing) is opt-in with MAPS_TRAFFIC_AWARE=true.
const STEP_FIELDS = "routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction,routes.legs.steps.startLocation,routes.legs.steps.endLocation";

export async function computeRoute(origin, destination, { cacheSeconds = 600, steps = false } = {}) {
  if (!mapsEnabled() || !origin || !destination) return null;
  const key = `maps:route${steps ? "+steps" : ""}:${r4(origin.lat)},${r4(origin.lng)}:${r4(destination.lat)},${r4(destination.lng)}`;
  if (cacheSeconds) {
    const cached = await cacheGet(key);
    if (cached) return cached;
  }
  if (!(await allow("routes"))) return null;
  try {
    const json = await google(ROUTES_URL, {
      method: "POST",
      fieldMask: "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline" + (steps ? "," + STEP_FIELDS : ""),
      body: {
        origin:      { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: "DRIVE",
        routingPreference: ENV.MAPS_TRAFFIC_AWARE ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE",
        units: "METRIC",
        languageCode: "en",
        regionCode: "tz",
      },
    });
    const r = json.routes?.[0];
    if (!r) return null;
    const route = {
      distanceMeters:  r.distanceMeters || 0,
      durationSeconds: parseInt(String(r.duration || "0s"), 10) || 0,
      polyline:        r.polyline?.encodedPolyline || "",
    };
    if (steps) {
      const at = (l) => (l?.latLng ? { lat: l.latLng.latitude, lng: l.latLng.longitude } : null);
      route.steps = (r.legs?.[0]?.steps || []).map((s) => ({
        maneuver:       s.navigationInstruction?.maneuver || "STRAIGHT",
        text:           s.navigationInstruction?.instructions || "",
        distanceMeters: s.distanceMeters || 0,
        start:          at(s.startLocation),
        end:            at(s.endLocation),
      }));
    }
    if (cacheSeconds) await cacheSet(key, route, cacheSeconds);
    return route;
  } catch (e) {
    console.error("[maps] route:", e.message);
    await refund("routes");
    return null;
  }
}

// ── Address search (Places API New) ───────────────────────────────────────────
// sessionToken groups the keystrokes and the final details lookup into one billed session.
export async function autocomplete(input, { near, sessionToken } = {}) {
  if (!mapsEnabled() || !input || input.trim().length < 2) return [];
  if (!(await allow("autocomplete"))) return [];
  const center = near || DEFAULT_CENTER;
  try {
    const json = await google(AUTOCOMPLETE_URL, {
      method: "POST",
      fieldMask: "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.distanceMeters",
      body: {
        input: input.trim().slice(0, 120),
        includedRegionCodes: ["tz"],
        regionCode: "tz",
        languageCode: "en",
        locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 30000 } },
        ...(near ? { origin: { latitude: near.lat, longitude: near.lng } } : {}),
        ...(sessionToken ? { sessionToken } : {}),
      },
    });
    if (sessionToken) await noteSearch(sessionToken);
    return (json.suggestions || [])
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .map((p) => ({
        placeId:        p.placeId,
        description:    p.text?.text || "",
        mainText:       p.structuredFormat?.mainText?.text || p.text?.text || "",
        secondaryText:  p.structuredFormat?.secondaryText?.text || "",
        distanceMeters: p.distanceMeters ?? null,
      }));
  } catch (e) {
    console.error("[maps] autocomplete:", e.message);
    await refund("autocomplete");
    return [];
  }
}

// Coordinates + address for a search result. Only "Essentials" fields are requested.
export async function placeDetails(placeId, { sessionToken } = {}) {
  if (!mapsEnabled() || !placeId) return null;
  const key = `maps:place:${placeId}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (!(await allow("details"))) return null;
  try {
    const qs = new URLSearchParams({ languageCode: "en", regionCode: "tz" });
    if (sessionToken) qs.set("sessionToken", sessionToken);
    const p = await google(`${PLACE_URL}${encodeURIComponent(placeId)}?${qs}`, {
      fieldMask: "id,formattedAddress,location",
    });
    // The search ended with a pick: its keystrokes are billed as free session usage
    if (sessionToken) await settleSearch(sessionToken);
    if (!p?.location) return null;
    const place = { placeId: p.id || placeId, address: p.formattedAddress || "", lat: p.location.latitude, lng: p.location.longitude };
    await cacheSet(key, place, 7 * 24 * 3600);
    return place;
  } catch (e) {
    console.error("[maps] place:", e.message);
    await refund("details");
    return null;
  }
}

// ── Coordinates → street address ──────────────────────────────────────────────
export async function reverseGeocode(lat, lng) {
  if (!mapsEnabled()) return null;
  const key = `maps:geo:${r4(lat)},${r4(lng)}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (!(await allow("geocode"))) return null;
  try {
    const qs = new URLSearchParams({ latlng: `${lat},${lng}`, key: ENV.GOOGLE_MAPS_API_KEY, language: "en", region: "tz" });
    const res = await fetch(`${GEOCODE_URL}?${qs}`, { signal: AbortSignal.timeout(6000) });
    const json = await res.json();
    if (json.status !== "OK" || !json.results?.length) {
      // ZERO_RESULTS is a billed answer; error statuses are not
      if (json.status !== "ZERO_RESULTS") {
        console.error("[maps] geocode:", json.status, json.error_message || "");
        await refund("geocode");
      }
      return null;
    }
    // Skip bare plus codes ("XXXX+XX") when a real address is available
    const best = json.results.find((r) => !r.types?.includes("plus_code")) || json.results[0];
    const out = { address: best.formatted_address };
    await cacheSet(key, out, 24 * 3600);
    return out;
  } catch (e) {
    console.error("[maps] geocode:", e.message);
    await refund("geocode");
    return null;
  }
}
