/**
 * Nearest-driver dispatch.
 *
 * A new delivery is offered to the closest free drivers first, and the search widens
 * in waves until someone accepts:
 *   wave 1 → the 3 nearest within 3 km; 30 s later wave 2 → the next 5 within 6 km;
 *   then 10 km, 15 km and 25 km. Rings with nobody in them are skipped at once, and the
 *   last ring is swept every 30 s for drivers who come online later.
 * A driver qualifies when they are approved, active, online, drive the requested
 * vehicle, sent a GPS fix in the last 2 minutes and are not already on a delivery.
 * Distance is from the driver's live position to the pickup point: the seller's shop.
 */
import { query, queryOne, execute } from "../config/db.js";
import { getRedis } from "../config/redis.js";
import { ENV } from "../config/env.js";
import { sendPushNotification } from "./notification.service.js";
import { DRIVER_SHARE } from "./fare.service.js";
import { toLatLng, estimateEtaSeconds } from "./geo.js";

export const WAVES = [
  { radiusKm: 3,  size: 3 },
  { radiusKm: 6,  size: 5 },
  { radiusKm: 10, size: 8 },
  { radiusKm: 15, size: 12 },
  { radiusKm: 25, size: 20 },
];
export const WAVE_SECONDS  = 30;  // time a wave gets to accept before the search widens
export const FRESH_SECONDS = 120; // a driver's last GPS fix must be at most this old
export const ACTIVE_RIDE_STATUSES = ["accepted", "going_to_shop", "picked_up", "on_the_way"];
export const ACTIVE_SQL = ACTIVE_RIDE_STATUSES.map((s) => `'${s}'`).join(",");

const round1 = (n) => Math.round(n * 10) / 10;

// ── Pickup point of an order: the seller's shop ──────────────────────────────
// Orders read with this query carry everything resolvePickup needs.
export const ORDER_WITH_SHOP_SQL = `
  SELECT o.*, sp.id AS sp_id, sp.shop_name, sp.shop_address, sp.shop_lat, sp.shop_lng,
         sp.shop_phone, su.phone AS seller_phone
  FROM orders o
  LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id
  LEFT JOIN users su ON su.id = o.seller_id`;

// { lat, lng, name, address, phone } or null when the shop hasn't set its location
export function resolvePickup(order) {
  const shop = toLatLng(order.shop_lat, order.shop_lng);
  if (shop) {
    return { ...shop, name: order.shop_name || "Shop", address: order.shop_address || "",
             phone: order.shop_phone || order.seller_phone || "" };
  }
  // OneDelivery's own store items have no seller profile; they leave from the store
  if (!order.sp_id) {
    const store = toLatLng(ENV.STORE_PICKUP_LAT, ENV.STORE_PICKUP_LNG);
    if (store) {
      return { ...store, name: ENV.STORE_PICKUP_NAME, address: ENV.STORE_PICKUP_ADDRESS, phone: ENV.STORE_PICKUP_PHONE };
    }
  }
  return null;
}

export const pickupLabel = (p) => (p.address ? `${p.name} · ${p.address}` : p.name);

// ── Free drivers near a point, nearest first ─────────────────────────────────
export async function findNearbyDrivers({ lat, lng }, { vehicleType = null, radiusKm, limit = 10, excludeRideId = null }) {
  // A bounding box narrows the rows before the distance maths runs
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const params = [lat, lat, lng, FRESH_SECONDS, lat - dLat, lat + dLat, lng - dLng, lng + dLng];
  let extra = "";
  if (vehicleType) { extra += " AND dp.vehicle_type = ?"; params.push(vehicleType); }
  if (excludeRideId) {
    extra += " AND NOT EXISTS (SELECT 1 FROM ride_offers ro WHERE ro.ride_id = ? AND ro.driver_id = dp.id)";
    params.push(excludeRideId);
  }
  params.push(radiusKm);
  const rows = await query(
    `SELECT dp.id, dp.user_id, dp.vehicle_type, dp.rating, dp.current_lat, dp.current_lng,
            6371 * 2 * ASIN(SQRT(
              POW(SIN(RADIANS(dp.current_lat - ?) / 2), 2) +
              COS(RADIANS(?)) * COS(RADIANS(dp.current_lat)) * POW(SIN(RADIANS(dp.current_lng - ?) / 2), 2)
            )) AS distance_km
     FROM driver_profiles dp
     JOIN users u ON u.id = dp.user_id AND u.is_active = 1
     WHERE dp.is_approved = 1 AND dp.is_online = 1
       AND dp.last_seen >= NOW() - INTERVAL ? SECOND
       AND dp.current_lat BETWEEN ? AND ? AND dp.current_lng BETWEEN ? AND ?
       ${extra}
       AND NOT EXISTS (SELECT 1 FROM ride_requests r WHERE r.driver_id = dp.id AND r.status IN (${ACTIVE_SQL}))
     HAVING distance_km <= ?
     ORDER BY distance_km ASC, dp.rating DESC
     LIMIT ${Math.max(1, Math.min(100, limit | 0))}`,
    params
  );
  return rows.map((d) => ({ ...d, distance_km: parseFloat(d.distance_km) }));
}

// Free drivers per vehicle type around a pickup point (for the customer's vehicle picker)
export async function nearbySummary(pickup, radiusKm = 10) {
  const drivers = await findNearbyDrivers(pickup, { radiusKm, limit: 100 });
  const byType = {};
  for (const d of drivers) {
    const t = (byType[d.vehicle_type] ||= { count: 0, nearestKm: null });
    t.count += 1;
    if (t.nearestKm == null || d.distance_km < t.nearestKm) t.nearestKm = d.distance_km;
  }
  return byType;
}

// What a driver sees about a delivery before accepting it. `fare` is the customer's
// current offer; the driver can accept it or send their own price (counter).
export function offerPayload(ride, pickupKm, myOffer = null) {
  const fare = parseFloat(ride.offered_fare ?? ride.fare) || 0;
  const tripMeters = ride.route_distance_m || (parseFloat(ride.distance_km) || 0) * 1000;
  const myCounter = myOffer?.counter_fare != null ? parseFloat(myOffer.counter_fare) : null;
  return {
    id: ride.id,
    vehicle_type: ride.vehicle_type,
    status: ride.status,
    fare,
    earning: Math.round(fare * DRIVER_SHARE),
    suggested_fare: ride.suggested_fare != null ? parseFloat(ride.suggested_fare) : fare,
    payment_method: ride.payment_method || "mobile",
    offer_status: myOffer?.status || "offered",
    my_counter: myCounter,
    my_counter_earning: myCounter != null ? Math.round(myCounter * DRIVER_SHARE) : null,
    pickup_lat: parseFloat(ride.pickup_lat),
    pickup_lng: parseFloat(ride.pickup_lng),
    pickup_address: ride.pickup_address || "",
    dropoff_lat: parseFloat(ride.dropoff_lat),
    dropoff_lng: parseFloat(ride.dropoff_lng),
    dropoff_address: ride.dropoff_address || "",
    shop_name: ride.shop_name || null,
    customer_name: ride.customer_name || null,
    distance_km: parseFloat(ride.distance_km) || 0,
    trip_km: round1(tripMeters / 1000),
    trip_min: ride.route_duration_s ? Math.max(1, Math.round(ride.route_duration_s / 60)) : null,
    pickup_distance_km: pickupKm != null ? round1(pickupKm) : null,
    pickup_eta_min: pickupKm != null ? Math.max(1, Math.round(estimateEtaSeconds(pickupKm * 1000, ride.vehicle_type) / 60)) : null,
    delivery_fee_paid: !!ride.delivery_fee_paid,
    created_at: ride.created_at,
  };
}

async function sendOffers(io, ride, drivers, wave) {
  let sent = 0;
  for (const d of drivers) {
    const r = await execute(
      "INSERT IGNORE INTO ride_offers (ride_id, driver_id, driver_user_id, wave, distance_km) VALUES (?, ?, ?, ?, ?)",
      [ride.id, d.id, d.user_id, wave, Math.round(d.distance_km * 100) / 100]
    );
    if (!r.affectedRows) continue;
    sent += 1;
    const offer = offerPayload(ride, d.distance_km);
    io?.to(`user:${d.user_id}`).emit("ride:offer", offer);
    sendPushNotification(d.user_id, {
      title: "🛵 New delivery nearby",
      body:  `Pickup ${offer.pickup_distance_km} km away · Earn TZS ${offer.earning.toLocaleString()}`,
      type:  "new_ride_request",
      sound: true,
      app:   "driver",
      data:  { rideId: ride.id, screen: "ride_offer" },
    }).catch(() => {});
  }
  return sent;
}

// Run the next wave for a ride that is still searching. Returns how many drivers got it.
export async function dispatchRide(io, rideId) {
  const redis = getRedis();
  const lockKey = `lock:dispatch:${rideId}`;
  // One dispatcher per ride at a time; if Redis is down, carry on without the lock
  const locked = await redis.set(lockKey, "1", "EX", 15, "NX").catch(() => "OK");
  if (!locked) return 0;
  try {
    const ride = await queryOne(
      `SELECT r.*, sp.shop_name, u.name AS customer_name
       FROM ride_requests r
       JOIN users u ON u.id = r.customer_id
       LEFT JOIN orders o ON o.id = r.order_id
       LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id
       WHERE r.id = ?`,
      [rideId]
    );
    if (!ride || ride.status !== "searching") return 0;
    const pickup = toLatLng(ride.pickup_lat, ride.pickup_lng);
    if (!pickup) return 0;

    let done = Math.min(ride.dispatch_wave || 0, WAVES.length);
    let sent = 0;
    for (;;) {
      const idx = Math.min(done, WAVES.length - 1);
      const { radiusKm, size } = WAVES[idx];
      const drivers = await findNearbyDrivers(pickup, {
        vehicleType: ride.vehicle_type, radiusKm, limit: size, excludeRideId: ride.id,
      });
      sent = await sendOffers(io, ride, drivers, idx + 1);
      done = Math.min(done + 1, WAVES.length);
      // Nobody free in this ring: widen straight away instead of waiting out the wave
      if (sent > 0 || idx === WAVES.length - 1) break;
    }
    await execute(
      "UPDATE ride_requests SET dispatch_wave = ?, dispatched_at = NOW() WHERE id = ? AND status = 'searching'",
      [done, ride.id]
    );
    return sent;
  } finally {
    redis.del(lockKey).catch(() => {});
  }
}

// Background job: widen the search for rides whose current wave has run its time
export async function escalateDispatch(io) {
  try {
    const rows = await query(
      `SELECT id FROM ride_requests
       WHERE status = 'searching'
         AND (dispatched_at IS NULL OR dispatched_at <= NOW() - INTERVAL ${WAVE_SECONDS} SECOND)
       ORDER BY created_at ASC LIMIT 50`
    );
    for (const r of rows) await dispatchRide(io, r.id);
  } catch (e) {
    console.error("[dispatch] escalate:", e.message);
  }
}

// Offers a driver can still act on: not yet answered, or answered with their own price
export const OPEN_OFFER_SQL = "status IN ('offered','countered')";

// Close a ride's open offers and tell those drivers to drop it from their screen.
// reason: "taken" (someone accepted), "cancelled" or "expired".
export async function closeOffers(io, rideId, reason, { exceptDriverId = null } = {}) {
  const status = reason === "taken" ? "taken" : "expired";
  const except = exceptDriverId ? " AND driver_id <> ?" : "";
  const args = exceptDriverId ? [rideId, exceptDriverId] : [rideId];
  const rows = await query(`SELECT driver_user_id FROM ride_offers WHERE ride_id = ? AND ${OPEN_OFFER_SQL}${except}`, args);
  if (!rows.length) return;
  await execute(`UPDATE ride_offers SET status = ?, responded_at = NOW() WHERE ride_id = ? AND ${OPEN_OFFER_SQL}${except}`, [status, ...args]);
  for (const r of rows) io?.to(`user:${r.driver_user_id}`).emit("ride:closed", { rideId, reason });
}

// A driver is no longer available (took a delivery, went offline): their open offers on
// other deliveries expire, and customers looking at their price are told it's gone
export async function withdrawDriverOffers(io, { driverId = null, driverUserId = null, exceptRideId = null }) {
  const who = driverId ? "o.driver_id = ?" : "o.driver_user_id = ?";
  const args = [driverId || driverUserId];
  const except = exceptRideId ? " AND o.ride_id <> ?" : "";
  if (exceptRideId) args.push(exceptRideId);
  const rows = await query(
    `SELECT o.ride_id, o.driver_id, o.status, r.customer_id
     FROM ride_offers o JOIN ride_requests r ON r.id = o.ride_id
     WHERE ${who} AND o.${OPEN_OFFER_SQL}${except}`,
    args
  );
  if (!rows.length) return;
  await execute(`UPDATE ride_offers o SET o.status = 'expired', o.responded_at = NOW() WHERE ${who} AND o.${OPEN_OFFER_SQL}${except}`, args);
  for (const r of rows) {
    if (r.status === "countered") io?.to(`user:${r.customer_id}`).emit("ride:counter_withdrawn", { rideId: r.ride_id, driverId: r.driver_id });
  }
}
