/**
 * Live delivery tracking: driver positions, the route of the current leg
 * (driver → shop before pickup, driver → customer after) and the ETA shown in
 * the driver, customer and seller apps.
 * A road route is fetched from Google only when a leg starts or the driver leaves
 * the line; between those, the ETA is scaled by how much of the route is left.
 */
import { queryOne, execute } from "../config/db.js";
import { cacheGet, cacheSet, cacheDel, getRedis, setDriverOnline, getDriverLocation } from "../config/redis.js";
import { computeRoute, mapsEnabled } from "./maps.service.js";
import { ACTIVE_SQL } from "./dispatch.service.js";
import { decodePolyline, routeProgress, haversineMeters, estimateEtaSeconds, toLatLng } from "./geo.js";

const OFF_ROUTE_METERS   = 120;    // further than this from the route line → re-route
const REROUTE_GAP_MS     = 30_000; // at most one re-route per ride every 30 s
const DB_WRITE_GAP_MS    = 10_000; // positions go to MySQL at most every 10 s per driver
const ACTIVE_CACHE_MS    = 15_000;

export function legFor(status) {
  if (status === "accepted" || status === "going_to_shop") return "to_pickup";
  if (status === "picked_up" || status === "on_the_way") return "to_dropoff";
  return null;
}

// ── Driver positions ─────────────────────────────────────────────────────────
const lastDbWrite = new Map(); // driver userId → ms

export async function recordDriverLocation(userId, lat, lng, heading = 0) {
  const now = Date.now();
  if (now - (lastDbWrite.get(userId) || 0) >= DB_WRITE_GAP_MS) {
    lastDbWrite.set(userId, now);
    await execute(
      "UPDATE driver_profiles SET current_lat = ?, current_lng = ?, heading = ?, last_seen = NOW() WHERE user_id = ?",
      [lat, lng, heading, userId]
    );
  }
  // Redis holds the live position; it expires 2 minutes after the last fix
  await setDriverOnline(userId, lat, lng, heading).catch(() => {});
}

export function forgetDriverWrites(userId) {
  lastDbWrite.delete(userId);
}

// Latest known position of a driver: Redis first, MySQL as the fallback
export async function driverPosition(userId) {
  const loc = await getDriverLocation(userId).catch(() => null);
  if (loc?.lat) {
    const p = toLatLng(loc.lat, loc.lng);
    if (p) return { ...p, heading: parseFloat(loc.heading) || 0, at: parseInt(loc.ts, 10) || null };
  }
  const dp = await queryOne("SELECT current_lat, current_lng, heading, last_seen FROM driver_profiles WHERE user_id = ?", [userId]);
  const p = dp && toLatLng(dp.current_lat, dp.current_lng);
  return p ? { ...p, heading: parseFloat(dp.heading) || 0, at: dp.last_seen ? new Date(dp.last_seen).getTime() : null } : null;
}

// ── The driver's active delivery (cached briefly; GPS fixes arrive every few seconds) ──
const activeCache = new Map(); // driver userId → { at, ride }

export async function activeRideForDriver(userId) {
  const hit = activeCache.get(userId);
  if (hit && Date.now() - hit.at < ACTIVE_CACHE_MS) return hit.ride;
  const ride = await queryOne(
    `SELECT r.id, r.customer_id, r.status, r.vehicle_type,
            r.pickup_lat, r.pickup_lng, r.dropoff_lat, r.dropoff_lng, o.seller_id
     FROM ride_requests r
     JOIN driver_profiles dp ON dp.id = r.driver_id
     LEFT JOIN orders o ON o.id = r.order_id
     WHERE dp.user_id = ? AND r.status IN (${ACTIVE_SQL})
     ORDER BY r.accepted_at DESC LIMIT 1`,
    [userId]
  );
  activeCache.set(userId, { at: Date.now(), ride });
  return ride;
}

export function forgetActiveRide(userId) {
  activeCache.delete(userId);
}

// ── Route of the current leg ─────────────────────────────────────────────────
const decoded = new Map(); // rideId → { polyline, points }

function pointsOf(rideId, polyline) {
  const hit = decoded.get(rideId);
  if (hit?.polyline === polyline) return hit.points;
  const points = decodePolyline(polyline);
  decoded.set(rideId, { polyline, points });
  if (decoded.size > 1000) decoded.delete(decoded.keys().next().value);
  return points;
}

// { leg, target, polyline, version, remainingMeters, etaSeconds, estimated } or null.
// `estimated` means no road route was available and the numbers are straight-line guesses.
export async function legRoute(ride, driverPos) {
  const leg = legFor(ride.status);
  if (!leg || !driverPos) return null;
  const target = leg === "to_pickup" ? toLatLng(ride.pickup_lat, ride.pickup_lng) : toLatLng(ride.dropoff_lat, ride.dropoff_lng);
  if (!target) return null;

  const key = `ride:leg:${ride.id}`;
  let route = await cacheGet(key);
  if (route && route.leg !== leg) route = null;
  let progress = route?.polyline ? routeProgress(pointsOf(ride.id, route.polyline), driverPos) : null;

  const offRoute = progress && progress.offRouteMeters > OFF_ROUTE_METERS && Date.now() - route.computedAt > REROUTE_GAP_MS;
  if ((!route || offRoute) && mapsEnabled()) {
    const lock = await getRedis().set(`lock:leg:${ride.id}`, "1", "EX", 20, "NX").catch(() => null);
    if (lock) {
      // With turn-by-turn steps for the driver's navigation banner
      const fresh = await computeRoute(driverPos, target, { cacheSeconds: 0, steps: true });
      if (fresh?.polyline) {
        route = { leg, ...fresh, computedAt: Date.now() };
        await cacheSet(key, route, 6 * 3600);
        progress = routeProgress(pointsOf(ride.id, route.polyline), driverPos);
      }
    }
  }

  if (!route || !progress) {
    const meters = Math.round(haversineMeters(driverPos, target));
    return { leg, target, polyline: null, version: null, remainingMeters: meters,
             etaSeconds: estimateEtaSeconds(meters, ride.vehicle_type), estimated: true };
  }

  // Still off the line (re-route pending): add the gap back to the road
  const remaining = progress.remainingMeters + (progress.offRouteMeters > OFF_ROUTE_METERS ? progress.offRouteMeters : 0);
  let eta = route.distanceMeters > 0
    ? Math.round(route.durationSeconds * (remaining / route.distanceMeters))
    : estimateEtaSeconds(remaining, ride.vehicle_type);
  if (remaining > 50) eta = Math.max(eta, 60);
  return { leg, target, polyline: route.polyline, version: route.computedAt,
           remainingMeters: Math.round(remaining), etaSeconds: eta, estimated: false,
           steps: route.steps || [] };
}

export async function clearLegRoute(rideId) {
  decoded.delete(rideId);
  await cacheDel(`ride:leg:${rideId}`);
}

// ── Fan a driver's fix out to everyone watching their delivery ───────────────
// The ride is looked up from the driver's own active delivery, never from the
// client payload, so a driver can't push positions onto someone else's order.
export async function broadcastDriverLocation(io, userId, pos) {
  if (!io) return;
  const ride = await activeRideForDriver(userId);
  if (!ride) return;
  const leg = await legRoute(ride, pos).catch(() => null);
  const payload = {
    rideId: ride.id,
    lat: pos.lat,
    lng: pos.lng,
    heading: pos.heading || 0,
    status: ride.status,
    leg: leg?.leg || null,
    etaSeconds: leg?.etaSeconds ?? null,
    remainingMeters: leg?.remainingMeters ?? null,
    routeVersion: leg?.version ?? null,
  };
  io.to(`user:${ride.customer_id}`).emit("driver:location_update", payload);
  if (ride.seller_id) io.to(`user:${ride.seller_id}`).emit("driver:location_update", payload);
  io.to(`user:${userId}`).emit("ride:progress", payload);
}

// Tell the customer, seller and driver apps that a delivery changed state
export function emitRideStatus(io, { rideId, status, customerId, sellerId, driverUserId }) {
  if (!io) return;
  const payload = { rideId, status };
  for (const uid of [customerId, sellerId, driverUserId]) {
    if (uid) io.to(`user:${uid}`).emit("ride:status", payload);
  }
}
