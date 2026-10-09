// Geometry helpers shared by maps, dispatch and live tracking.
// Coordinates are { lat, lng } in degrees; distances are in metres unless named *Km.

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Real-looking coordinates only: in range and not the 0,0 a phone reports without a fix
export function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6);
}

export function toLatLng(lat, lng) {
  const p = { lat: parseFloat(lat), lng: parseFloat(lng) };
  return isValidLatLng(p.lat, p.lng) ? p : null;
}

// Google encoded polyline → [{ lat, lng }]
export function decodePolyline(encoded = "") {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

// Where `pos` sits along a route: how far it is from the line and how much of the route is left
export function routeProgress(points, pos) {
  if (!points || points.length < 2 || !pos) return null;
  let total = 0;
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i]);
    cum.push(total);
  }
  let bestDist = Infinity, bestAlong = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    // Local flat projection is accurate to centimetres over a road segment
    const kx = 111320 * Math.cos(toRad((a.lat + b.lat) / 2)), ky = 110540;
    const ax = a.lng * kx, ay = a.lat * ky;
    const dx = b.lng * kx - ax, dy = b.lat * ky - ay;
    const px = pos.lng * kx - ax, py = pos.lat * ky - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
    const dist = Math.hypot(px - t * dx, py - t * dy);
    if (dist < bestDist) { bestDist = dist; bestAlong = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
  }
  return { offRouteMeters: bestDist, remainingMeters: Math.max(0, total - bestAlong), totalMeters: total };
}

// Typical city speeds (km/h) used when no road route is available
const CITY_SPEED_KMH = { bodaboda: 25, bajaj: 20, toyo: 22, pickup: 20 };

// Straight-line distance is shorter than the road; 1.3 is a common city detour factor
export function estimateEtaSeconds(meters, vehicleType) {
  const kmh = CITY_SPEED_KMH[vehicleType] || 22;
  return Math.round(((meters * 1.3) / 1000 / kmh) * 3600);
}
