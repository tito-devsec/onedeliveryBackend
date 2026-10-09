/**
 * Google Maps Platform, called from the server only so the key never ships in the apps.
 *  • Routes API             — road routes (distance, duration, polyline)
 *  • Places API (New)       — address search (autocomplete + place details)
 *  • Geocoding API          — coordinates → address
 * The legacy Directions / Places web services can't be enabled on new Google Cloud
 * projects, so they are not used. Results are cached in Redis to keep the bill small.
 */
import { ENV } from "../config/env.js";
import { cacheGet, cacheSet } from "../config/redis.js";

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

// ── Road route A → B ──────────────────────────────────────────────────────────
// Returns { distanceMeters, durationSeconds, polyline } or null when unavailable.
// Live traffic (Routes "Pro" pricing) is opt-in with MAPS_TRAFFIC_AWARE=true.
export async function computeRoute(origin, destination, { cacheSeconds = 600 } = {}) {
  if (!mapsEnabled() || !origin || !destination) return null;
  const key = `maps:route:${r4(origin.lat)},${r4(origin.lng)}:${r4(destination.lat)},${r4(destination.lng)}`;
  if (cacheSeconds) {
    const cached = await cacheGet(key);
    if (cached) return cached;
  }
  try {
    const json = await google(ROUTES_URL, {
      method: "POST",
      fieldMask: "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
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
    if (cacheSeconds) await cacheSet(key, route, cacheSeconds);
    return route;
  } catch (e) {
    console.error("[maps] route:", e.message);
    return null;
  }
}

// ── Address search (Places API New) ───────────────────────────────────────────
// sessionToken groups the keystrokes and the final details lookup into one billed session.
export async function autocomplete(input, { near, sessionToken } = {}) {
  if (!mapsEnabled() || !input || input.trim().length < 2) return [];
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
    return [];
  }
}

// Coordinates + address for a search result. Only "Essentials" fields are requested.
export async function placeDetails(placeId, { sessionToken } = {}) {
  if (!mapsEnabled() || !placeId) return null;
  const key = `maps:place:${placeId}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  try {
    const qs = new URLSearchParams({ languageCode: "en", regionCode: "tz" });
    if (sessionToken) qs.set("sessionToken", sessionToken);
    const p = await google(`${PLACE_URL}${encodeURIComponent(placeId)}?${qs}`, {
      fieldMask: "id,formattedAddress,location",
    });
    if (!p?.location) return null;
    const place = { placeId: p.id || placeId, address: p.formattedAddress || "", lat: p.location.latitude, lng: p.location.longitude };
    await cacheSet(key, place, 7 * 24 * 3600);
    return place;
  } catch (e) {
    console.error("[maps] place:", e.message);
    return null;
  }
}

// ── Coordinates → street address ──────────────────────────────────────────────
export async function reverseGeocode(lat, lng) {
  if (!mapsEnabled()) return null;
  const key = `maps:geo:${r4(lat)},${r4(lng)}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  try {
    const qs = new URLSearchParams({ latlng: `${lat},${lng}`, key: ENV.GOOGLE_MAPS_API_KEY, language: "en", region: "tz" });
    const res = await fetch(`${GEOCODE_URL}?${qs}`, { signal: AbortSignal.timeout(6000) });
    const json = await res.json();
    if (json.status !== "OK" || !json.results?.length) {
      if (json.status !== "ZERO_RESULTS") console.error("[maps] geocode:", json.status, json.error_message || "");
      return null;
    }
    // Skip bare plus codes ("XXXX+XX") when a real address is available
    const best = json.results.find((r) => !r.types?.includes("plus_code")) || json.results[0];
    const out = { address: best.formatted_address };
    await cacheSet(key, out, 24 * 3600);
    return out;
  } catch (e) {
    console.error("[maps] geocode:", e.message);
    return null;
  }
}
