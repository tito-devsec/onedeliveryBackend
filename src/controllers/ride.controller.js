import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute } from "../config/db.js";
import { getRedis, setDriverOffline } from "../config/redis.js";
import { ENV } from "../config/env.js";
import { sendPushNotification } from "../services/notification.service.js";
import { calcDistanceKm, calcFare, VEHICLE_INFO, DRIVER_SHARE } from "../services/fare.service.js";
import { computeRoute } from "../services/maps.service.js";
import { toLatLng, isValidLatLng, haversineMeters, estimateEtaSeconds } from "../services/geo.js";
import {
  ACTIVE_RIDE_STATUSES, ACTIVE_SQL, ORDER_WITH_SHOP_SQL, resolvePickup, pickupLabel,
  nearbySummary, dispatchRide, closeOffers, offerPayload,
} from "../services/dispatch.service.js";
import {
  recordDriverLocation, broadcastDriverLocation, driverPosition, legRoute, clearLegRoute,
  forgetActiveRide, forgetDriverWrites, emitRideStatus,
} from "../services/tracking.service.js";

const MAX_TRIP_KM = 300; // further than this is a bad GPS fix, not a delivery
const SHOP_NO_LOCATION = "This shop hasn't set its pickup location yet. We've asked the seller to add it — please try again later.";

const round1 = (n) => Math.round(n * 10) / 10;
const shortId = (id) => `#${String(id).slice(-6).toUpperCase()}`;
const ioOf = (req) => req.app.get("io");

// The shop has no location yet: ask the seller to add it (at most once a day per order)
async function askSellerForLocation(order) {
  if (!order.seller_id) return;
  const first = await getRedis().set(`notify:shoploc:${order.id}`, "1", "EX", 86400, "NX").catch(() => "OK");
  if (!first) return;
  sendPushNotification(order.seller_id, {
    title: "📍 Add your shop location",
    body:  `A customer wants delivery for order ${shortId(order.id)}. Set your shop's location so drivers can collect it.`,
    type:  "shop_location_missing",
    data:  { screen: "seller_dashboard", orderId: order.id },
  }).catch(() => {});
}

// mysql2 returns DECIMAL columns as strings
const NUMERIC = ["pickup_lat", "pickup_lng", "dropoff_lat", "dropoff_lng", "fare", "distance_km", "driver_rating_avg"];
function numify(ride) {
  if (!ride) return ride;
  for (const k of NUMERIC) if (ride[k] != null) ride[k] = parseFloat(ride[k]);
  return ride;
}

// GET /api/rides/options?pickup_lat&pickup_lng&dropoff_lat&dropoff_lng[&order_id]
export async function getVehicleOptions(req, res) {
  try {
    let pickup = toLatLng(req.query.pickup_lat, req.query.pickup_lng);
    const dropoff = toLatLng(req.query.dropoff_lat, req.query.dropoff_lng);

    // For an order, the pickup point is always the seller's shop
    if (req.query.order_id) {
      const order = await queryOne(`${ORDER_WITH_SHOP_SQL} WHERE o.id = ? AND o.user_id = ?`, [req.query.order_id, req.user.id]);
      if (!order) return res.status(404).json({ error: "Order not found" });
      const shop = resolvePickup(order);
      if (!shop) {
        askSellerForLocation(order).catch(() => {});
        return res.status(409).json({ error: SHOP_NO_LOCATION, code: "shop_location_missing" });
      }
      pickup = { lat: shop.lat, lng: shop.lng, name: shop.name, address: shop.address };
    }
    if (!pickup || !dropoff) return res.status(400).json({ error: "Pickup and drop-off locations are required" });

    const distKm = calcDistanceKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
    if (distKm > MAX_TRIP_KM) return res.status(400).json({ error: "The drop-off is too far from the shop for delivery" });

    const [route, nearby] = await Promise.all([
      computeRoute(pickup, dropoff),
      nearbySummary(pickup, 10).catch(() => ({})),
    ]);

    const options = Object.values(VEHICLE_INFO).map((v) => {
      const n = nearby[v.id];
      const pickupEtaMin = n?.nearestKm != null
        ? Math.max(1, Math.round(estimateEtaSeconds(n.nearestKm * 1000, v.id) / 60))
        : null;
      return {
        ...v,
        fare:        calcFare(v.id, distKm),
        distanceKm:  round1(distKm),
        available:   n?.count || 0,
        nearestKm:   n?.nearestKm != null ? round1(n.nearestKm) : null,
        pickupEtaMin,
        eta:         pickupEtaMin ? `Driver ~${pickupEtaMin} min away` : v.eta,
      };
    });

    res.json({
      options,
      distanceKm: round1(distKm),
      pickup,
      dropoff,
      route: route
        ? { distanceKm: round1(route.distanceMeters / 1000), durationMin: Math.max(1, Math.round(route.durationSeconds / 60)), polyline: route.polyline }
        : null,
    });
  } catch (err) {
    console.error("getVehicleOptions:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/rides/request
export async function requestRide(req, res) {
  try {
    const { orderId, vehicleType, pickupLat, pickupLng, pickupAddress, dropoffLat, dropoffLng, dropoffAddress } = req.body;
    if (!VEHICLE_INFO[vehicleType]) return res.status(400).json({ error: "Choose a delivery vehicle" });
    const dropoff = toLatLng(dropoffLat, dropoffLng);
    if (!dropoff) return res.status(400).json({ error: "Set the drop-off location" });

    let pickup, pickupText;
    if (orderId) {
      const order = await queryOne(`${ORDER_WITH_SHOP_SQL} WHERE o.id = ? AND o.user_id = ?`, [orderId, req.user.id]);
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.payment_status !== "success") return res.status(400).json({ error: "Order payment not confirmed" });
      const existing = await queryOne(
        "SELECT id FROM ride_requests WHERE order_id = ? AND status NOT IN ('cancelled','no_driver')", [orderId]
      );
      if (existing) return res.status(400).json({ error: "Delivery already requested for this order", rideId: existing.id });

      // Pickup is the seller's shop, never a point sent by the phone
      const shop = resolvePickup(order);
      if (!shop) {
        askSellerForLocation(order).catch(() => {});
        return res.status(409).json({ error: SHOP_NO_LOCATION, code: "shop_location_missing" });
      }
      pickup = shop;
      pickupText = pickupLabel(shop);
    } else {
      pickup = toLatLng(pickupLat, pickupLng);
      if (!pickup) return res.status(400).json({ error: "Set the pickup location" });
      pickupText = String(pickupAddress || "");
    }

    const distKm = calcDistanceKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
    if (distKm > MAX_TRIP_KM) return res.status(400).json({ error: "The drop-off is too far from the shop for delivery" });
    const fare   = calcFare(vehicleType, distKm);
    const route  = await computeRoute(pickup, dropoff);
    const rideId = uuidv4();

    await execute(
      `INSERT INTO ride_requests (id, customer_id, order_id, vehicle_type, status,
         pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address, fare, distance_km,
         route_polyline, route_distance_m, route_duration_s, searching_since)
       VALUES (?, ?, ?, ?, 'searching', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [rideId, req.user.id, orderId || null, vehicleType, pickup.lat, pickup.lng, pickupText.slice(0, 300),
       dropoff.lat, dropoff.lng, String(dropoffAddress || "").slice(0, 300), fare, Math.round(distKm * 100) / 100,
       route?.polyline || "", route?.distanceMeters ?? null, route?.durationSeconds ?? null]
    );

    // Offer it to the nearest free drivers; the dispatch job widens the search every 30 s
    const offered = await dispatchRide(ioOf(req), rideId).catch((e) => {
      console.error("dispatchRide:", e.message);
      return 0;
    });

    sendPushNotification(req.user.id, {
      title: "🔍 Finding a driver…",
      body:  "We're offering your delivery to the drivers nearest the shop.",
      type:  "ride_searching",
      data:  { rideId, screen: "track_order" },
    }).catch(() => {});

    res.status(201).json({ rideId, fare, distanceKm: round1(distKm), status: "searching", driversNotified: offered });
  } catch (err) {
    console.error("requestRide:", err.message);
    res.status(500).json({ error: "Failed to request ride" });
  }
}

// GET /api/rides/:rideId
export async function getRideStatus(req, res) {
  try {
    const ride = numify(await queryOne(
      `SELECT r.*, dp.plate_number, dp.vehicle_type AS driver_vehicle, dp.vehicle_color, dp.vehicle_model,
              dp.rating AS driver_rating_avg, dp.total_trips, dp.user_id AS driver_user_id,
              u.name AS driver_name, u.profile_image AS driver_image, u.phone AS driver_phone,
              sp.shop_name
       FROM ride_requests r
       LEFT JOIN driver_profiles dp ON r.driver_id = dp.id
       LEFT JOIN users u ON dp.user_id = u.id
       LEFT JOIN orders o ON o.id = r.order_id
       LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id
       WHERE r.id = ? AND r.customer_id = ?`,
      [req.params.rideId, req.user.id]
    ));
    if (!ride) return res.status(404).json({ error: "Ride not found" });

    // Live driver position and ETA for the current leg
    if (ride.driver_user_id && ACTIVE_RIDE_STATUSES.includes(ride.status)) {
      const pos = await driverPosition(ride.driver_user_id);
      if (pos) {
        ride.driver_lat = pos.lat;
        ride.driver_lng = pos.lng;
        ride.driver_heading = pos.heading;
        const leg = await legRoute(ride, pos).catch(() => null);
        if (leg) {
          ride.leg = leg.leg;
          ride.eta_seconds = leg.etaSeconds;
          ride.remaining_meters = leg.remainingMeters;
          ride.route_version = leg.version;
        }
      }
    }
    delete ride.route_polyline; // served by GET /rides/:id/route
    res.json({ ride });
  } catch (err) {
    console.error("getRideStatus:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/rides/:rideId/route — map data for the customer, the seller and the driver:
// the whole trip (shop → customer) and the live leg from the driver's position.
export async function rideRoute(req, res) {
  try {
    const ride = numify(await queryOne(
      `SELECT r.*, o.seller_id, dp.user_id AS driver_user_id
       FROM ride_requests r
       LEFT JOIN orders o ON o.id = r.order_id
       LEFT JOIN driver_profiles dp ON dp.id = r.driver_id
       WHERE r.id = ?`,
      [req.params.rideId]
    ));
    const allowed = ride && (req.user.role === "admin" || [ride.customer_id, ride.driver_user_id, ride.seller_id].includes(req.user.id));
    if (!allowed) return res.status(404).json({ error: "Ride not found" });

    const live = ride.driver_user_id && ACTIVE_RIDE_STATUSES.includes(ride.status);
    const driver = live ? await driverPosition(ride.driver_user_id) : null;
    const leg = driver ? await legRoute(ride, driver).catch(() => null) : null;

    res.json({
      status:  ride.status,
      pickup:  { lat: ride.pickup_lat, lng: ride.pickup_lng, address: ride.pickup_address },
      dropoff: { lat: ride.dropoff_lat, lng: ride.dropoff_lng, address: ride.dropoff_address },
      trip: ride.route_polyline
        ? { polyline: ride.route_polyline, distanceMeters: ride.route_distance_m, durationSeconds: ride.route_duration_s }
        : null,
      driver,
      leg,
    });
  } catch (err) {
    console.error("rideRoute:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/rides/order/:orderId  (get ride for an order)
export async function getRideByOrder(req, res) {
  try {
    const ride = numify(await queryOne(
      `SELECT r.id, r.status, r.vehicle_type, r.fare, r.distance_km, r.created_at,
              dp.plate_number, u.name AS driver_name
       FROM ride_requests r
       LEFT JOIN driver_profiles dp ON r.driver_id = dp.id
       LEFT JOIN users u ON dp.user_id = u.id
       WHERE r.order_id = ? AND r.customer_id = ?
       ORDER BY r.created_at DESC LIMIT 1`,
      [req.params.orderId, req.user.id]
    ));
    res.json({ ride: ride || null });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/rides/history
export async function rideHistory(req, res) {
  try {
    const rides = await query(
      `SELECT r.*, dp.vehicle_type AS driver_vehicle, u.name AS driver_name
       FROM ride_requests r
       LEFT JOIN driver_profiles dp ON r.driver_id = dp.id
       LEFT JOIN users u ON dp.user_id = u.id
       WHERE r.customer_id = ?
       ORDER BY r.created_at DESC LIMIT 30`,
      [req.user.id]
    );
    res.json({ rides: rides.map(numify) });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// DELETE /api/rides/:rideId/cancel
export async function cancelRide(req, res) {
  try {
    const ride = await queryOne(
      `SELECT r.*, o.seller_id, dp.user_id AS driver_user_id
       FROM ride_requests r
       LEFT JOIN orders o ON o.id = r.order_id
       LEFT JOIN driver_profiles dp ON dp.id = r.driver_id
       WHERE r.id = ? AND r.customer_id = ?`,
      [req.params.rideId, req.user.id]
    );
    if (!ride) return res.status(404).json({ error: "Ride not found" });
    if (["picked_up","on_the_way","delivered"].includes(ride.status)) {
      return res.status(400).json({ error: "Cannot cancel after pickup" });
    }
    const r = await execute(
      `UPDATE ride_requests SET status = 'cancelled', cancelled_at = NOW(), cancelled_reason = 'Cancelled by customer'
       WHERE id = ? AND status IN ('searching','accepted','going_to_shop')`,
      [ride.id]
    );
    if (!r.affectedRows) return res.status(400).json({ error: "This delivery can no longer be cancelled" });

    const io = ioOf(req);
    await closeOffers(io, ride.id, "cancelled");
    if (ride.driver_user_id) {
      forgetActiveRide(ride.driver_user_id);
      sendPushNotification(ride.driver_user_id, { title: "❌ Ride Cancelled", body: "Customer cancelled the delivery.", type: "ride_cancelled", data: { rideId: ride.id }, app: "driver" }).catch(() => {});
    }
    await clearLegRoute(ride.id);
    emitRideStatus(io, { rideId: ride.id, status: "cancelled", customerId: ride.customer_id, sellerId: ride.seller_id, driverUserId: ride.driver_user_id });
    res.json({ message: "Ride cancelled" });
  } catch (err) {
    res.status(500).json({ error: "Cancel failed" });
  }
}

// ── DRIVER ENDPOINTS ─────────────────────────────────────────────────────────

const activeRideOf = (driverProfileId) =>
  queryOne(`SELECT id FROM ride_requests WHERE driver_id = ? AND status IN (${ACTIVE_SQL}) LIMIT 1`, [driverProfileId]);

// GET /api/rides/driver/available — deliveries offered to this driver, nearest pickup first
export async function availableRides(req, res) {
  try {
    const dp = await queryOne("SELECT * FROM driver_profiles WHERE user_id = ?", [req.user.id]);
    if (!dp) return res.status(403).json({ error: "Not registered as driver" });
    if (!dp.is_approved) return res.status(403).json({ error: "Driver not yet approved" });
    if (await activeRideOf(dp.id)) return res.json({ rides: [] }); // busy drivers get no new offers

    const rows = await query(
      `SELECT r.*, u.name AS customer_name, sp.shop_name, ro.distance_km AS offered_km
       FROM ride_offers ro
       JOIN ride_requests r ON r.id = ro.ride_id
       JOIN users u ON u.id = r.customer_id
       LEFT JOIN orders o ON o.id = r.order_id
       LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id
       WHERE ro.driver_id = ? AND ro.status = 'offered' AND r.status = 'searching'
       ORDER BY ro.offered_at DESC LIMIT 20`,
      [dp.id]
    );
    const here = (await driverPosition(req.user.id)) || toLatLng(dp.current_lat, dp.current_lng);
    const rides = rows
      .map((r) => {
        const pickup = toLatLng(r.pickup_lat, r.pickup_lng);
        const km = here && pickup ? haversineMeters(here, pickup) / 1000 : parseFloat(r.offered_km);
        return offerPayload(r, km);
      })
      .sort((a, b) => (a.pickup_distance_km ?? 999) - (b.pickup_distance_km ?? 999));
    res.json({ rides });
  } catch (err) {
    console.error("availableRides:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/rides/:rideId/accept
export async function acceptRide(req, res) {
  const redis = getRedis();
  let lockKey = null;
  try {
    const dp = await queryOne("SELECT id, user_id FROM driver_profiles WHERE user_id = ? AND is_approved = 1", [req.user.id]);
    if (!dp) return res.status(403).json({ error: "Driver not approved" });

    // One accept at a time per driver, so nobody ends up with two deliveries
    lockKey = `lock:accept:${dp.id}`;
    const locked = await redis.set(lockKey, "1", "EX", 10, "NX").catch(() => "OK");
    if (!locked) return res.status(409).json({ error: "Already accepting a delivery" });

    if (await activeRideOf(dp.id)) return res.status(409).json({ error: "Finish your current delivery first" });

    const offer = await queryOne("SELECT status FROM ride_offers WHERE ride_id = ? AND driver_id = ?", [req.params.rideId, dp.id]);
    if (!offer) return res.status(403).json({ error: "This delivery was offered to drivers closer to the shop" });
    if (offer.status !== "offered") return res.status(409).json({ error: "This delivery is no longer available" });

    // Atomic claim: only one driver can move a ride out of 'searching'
    const claim = await execute(
      "UPDATE ride_requests SET status = 'accepted', driver_id = ?, accepted_at = NOW() WHERE id = ? AND status = 'searching' AND driver_id IS NULL",
      [dp.id, req.params.rideId]
    );
    if (claim.affectedRows !== 1) {
      await execute("UPDATE ride_offers SET status = 'taken', responded_at = NOW() WHERE ride_id = ? AND driver_id = ?", [req.params.rideId, dp.id]);
      return res.status(409).json({ error: "Another driver already took this delivery" });
    }
    await execute("UPDATE ride_offers SET status = 'accepted', responded_at = NOW() WHERE ride_id = ? AND driver_id = ?", [req.params.rideId, dp.id]);

    const io = ioOf(req);
    await closeOffers(io, req.params.rideId, "taken", { exceptDriverId: dp.id });
    forgetActiveRide(req.user.id);

    const ride = await queryOne(
      "SELECT r.*, o.seller_id FROM ride_requests r LEFT JOIN orders o ON o.id = r.order_id WHERE r.id = ?",
      [req.params.rideId]
    );
    const pos = await driverPosition(req.user.id);
    const pickup = toLatLng(ride.pickup_lat, ride.pickup_lng);
    const etaMin = pos && pickup ? Math.max(1, Math.round(estimateEtaSeconds(haversineMeters(pos, pickup), ride.vehicle_type) / 60)) : null;

    sendPushNotification(ride.customer_id, {
      title: "✅ Driver Found!",
      body:  etaMin ? `${req.user.name} accepted your delivery and is ~${etaMin} min from the shop.` : `${req.user.name} accepted your delivery.`,
      type:  "ride_accepted",
      data:  { rideId: ride.id, screen: "track_order" },
    }).catch(() => {});
    if (ride.order_id && ride.seller_id) {
      sendPushNotification(ride.seller_id, {
        title: "🛵 Driver on the way to your shop",
        body:  `${req.user.name} is coming to collect order ${shortId(ride.order_id)}${etaMin ? ` (~${etaMin} min)` : ""}. Please have it ready.`,
        type:  "ride_driver_assigned",
        data:  { rideId: ride.id, orderId: ride.order_id, screen: "seller_dashboard" },
      }).catch(() => {});
    }
    emitRideStatus(io, { rideId: ride.id, status: "accepted", customerId: ride.customer_id, sellerId: ride.seller_id, driverUserId: req.user.id });

    res.json({ message: "Ride accepted", rideId: ride.id });
  } catch (err) {
    console.error("acceptRide:", err.message);
    res.status(500).json({ error: "Accept failed" });
  } finally {
    if (lockKey) redis.del(lockKey).catch(() => {});
  }
}

// POST /api/rides/:rideId/decline — the offer goes to the next nearest driver
export async function declineRide(req, res) {
  try {
    const dp = await queryOne("SELECT id FROM driver_profiles WHERE user_id = ?", [req.user.id]);
    if (!dp) return res.status(403).json({ error: "Not a driver" });
    await execute(
      "UPDATE ride_offers SET status = 'declined', responded_at = NOW() WHERE ride_id = ? AND driver_id = ? AND status = 'offered'",
      [req.params.rideId, dp.id]
    );
    // Everyone in this wave said no: widen the search now instead of waiting for the timer
    const open = await queryOne("SELECT COUNT(*) AS c FROM ride_offers WHERE ride_id = ? AND status = 'offered'", [req.params.rideId]);
    if (!Number(open?.c)) dispatchRide(ioOf(req), req.params.rideId).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Decline failed" });
  }
}

// PUT /api/rides/:rideId/status  (driver updates status)
export async function updateRideStatus(req, res) {
  try {
    const { status } = req.body;
    const dp = await queryOne("SELECT * FROM driver_profiles WHERE user_id = ?", [req.user.id]);
    if (!dp) return res.status(403).json({ error: "Not a driver" });

    const ride = await queryOne(
      "SELECT r.*, o.seller_id FROM ride_requests r LEFT JOIN orders o ON o.id = r.order_id WHERE r.id = ? AND r.driver_id = ?",
      [req.params.rideId, dp.id]
    );
    if (!ride) return res.status(404).json({ error: "Ride not found" });

    const transitions = {
      accepted:      ["going_to_shop","cancelled"],
      going_to_shop: ["picked_up","cancelled"],
      picked_up:     ["on_the_way"],
      on_the_way:    ["delivered"],
    };
    if (!transitions[ride.status]?.includes(status)) {
      return res.status(400).json({ error: `Cannot transition from ${ride.status} to ${status}` });
    }

    const io = ioOf(req);
    forgetActiveRide(req.user.id);
    await clearLegRoute(ride.id);

    // A driver who can't make it releases the delivery: it goes back to the nearest
    // other drivers instead of being cancelled on the customer
    if (status === "cancelled") {
      await execute(
        `UPDATE ride_requests SET status = 'searching', driver_id = NULL, accepted_at = NULL, going_to_shop_at = NULL,
           dispatch_wave = 0, dispatched_at = NULL, searching_since = NOW()
         WHERE id = ? AND driver_id = ?`,
        [ride.id, dp.id]
      );
      await execute("UPDATE ride_offers SET status = 'released', responded_at = NOW() WHERE ride_id = ? AND driver_id = ?", [ride.id, dp.id]);
      sendPushNotification(ride.customer_id, {
        title: "🔄 Finding you another driver",
        body:  "Your driver couldn't make it, so we're sending your delivery to the next nearest driver.",
        type:  "ride_released",
        data:  { rideId: ride.id, screen: "track_order" },
      }).catch(() => {});
      emitRideStatus(io, { rideId: ride.id, status: "searching", customerId: ride.customer_id, sellerId: ride.seller_id, driverUserId: req.user.id });
      dispatchRide(io, ride.id).catch(() => {});
      return res.json({ message: "Delivery released" });
    }

    const tsCol = { going_to_shop: "going_to_shop_at", picked_up: "picked_up_at", on_the_way: "on_the_way_at", delivered: "delivered_at" }[status];
    const moved = await execute(`UPDATE ride_requests SET status = ?, ${tsCol} = NOW() WHERE id = ? AND status = ?`, [status, ride.id, ride.status]);
    if (!moved.affectedRows) return res.status(409).json({ error: "The delivery changed meanwhile — please refresh" });

    if (status === "delivered") {
      const driverEarning = parseFloat(ride.fare) * DRIVER_SHARE;
      await execute("UPDATE driver_profiles SET balance = balance + ?, total_earnings = total_earnings + ?, total_trips = total_trips + 1 WHERE id = ?",
        [driverEarning, driverEarning, dp.id]);
      await execute("INSERT INTO driver_earnings (id, driver_id, ride_id, amount, type, description) VALUES (?, ?, ?, ?, 'delivery', ?)",
        [uuidv4(), dp.id, ride.id, driverEarning, `Delivery #${ride.id.slice(-6)}`]);
    }

    // Keep the order in step with its delivery
    if (ride.order_id && status === "picked_up") {
      await execute("UPDATE orders SET status = 'shipped', shipped_at = COALESCE(shipped_at, NOW()) WHERE id = ? AND status IN ('pending','processing')", [ride.order_id]);
    }
    if (ride.order_id && status === "delivered") {
      await execute("UPDATE orders SET status = 'delivered', delivered_at = NOW() WHERE id = ? AND status <> 'cancelled'", [ride.order_id]);
    }

    const msgs = {
      going_to_shop: { title: "🏪 Driver at the shop",   body: "Your driver has arrived at the shop to collect your order." },
      picked_up:     { title: "📦 Order collected!",      body: "Your driver has your order and is coming." },
      on_the_way:    { title: "🚗 Order is on the way!",  body: "Your driver is heading to your location." },
      delivered:     { title: "🎉 Delivered!",            body: "Your order has arrived. Enjoy!" },
    };
    if (msgs[status]) {
      sendPushNotification(ride.customer_id, { ...msgs[status], type: `ride_${status}`, data: { rideId: ride.id, screen: "track_order" } }).catch(() => {});
    }
    // Keep the seller informed too
    if (ride.order_id && ride.seller_id && ["going_to_shop","picked_up","delivered"].includes(status)) {
      const smsg = {
        going_to_shop: { title: "🛵 Driver at your shop", body: `Hand over order ${shortId(ride.order_id)} to the driver.` },
        picked_up:     { title: "📦 Order picked up",     body: "Driver has collected your order." },
        delivered:     { title: "✅ Order Delivered",     body: "Your order was delivered to the customer." },
      }[status];
      sendPushNotification(ride.seller_id, { ...smsg, type: `ride_${status}`, data: { rideId: ride.id, orderId: ride.order_id, screen: "seller_dashboard" } }).catch(() => {});
    }
    emitRideStatus(io, { rideId: ride.id, status, customerId: ride.customer_id, sellerId: ride.seller_id, driverUserId: req.user.id });

    res.json({ message: `Status updated to ${status}` });
  } catch (err) {
    console.error("updateRideStatus:", err.message);
    res.status(500).json({ error: "Status update failed" });
  }
}

// PUT /api/rides/driver/location — also the heartbeat from the app's background location task
export async function updateDriverLocation(req, res) {
  try {
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    if (!isValidLatLng(lat, lng)) return res.status(400).json({ error: "lat and lng required" });
    const heading = Number(req.body.heading) || 0;
    await recordDriverLocation(req.user.id, lat, lng, heading);
    broadcastDriverLocation(ioOf(req), req.user.id, { lat, lng, heading }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// PUT /api/rides/driver/online  { isOnline, lat?, lng?, heading? }
export async function toggleOnline(req, res) {
  try {
    const { isOnline } = req.body;
    if (isOnline) {
      await execute("UPDATE driver_profiles SET is_online = 1 WHERE user_id = ?", [req.user.id]);
      // A fresh fix makes the driver matchable straight away
      const p = toLatLng(req.body.lat, req.body.lng);
      if (p) {
        forgetDriverWrites(req.user.id);
        await recordDriverLocation(req.user.id, p.lat, p.lng, Number(req.body.heading) || 0);
      }
    } else {
      await execute("UPDATE driver_profiles SET is_online = 0 WHERE user_id = ?", [req.user.id]);
      await setDriverOffline(req.user.id).catch(() => {});
      // Offers this driver was holding go back to the search
      await execute(
        "UPDATE ride_offers SET status = 'expired', responded_at = NOW() WHERE driver_user_id = ? AND status = 'offered'",
        [req.user.id]
      );
    }
    res.json({ isOnline: !!isOnline });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/rides/driver/current
export async function driverCurrentRide(req, res) {
  try {
    const dp = await queryOne("SELECT id FROM driver_profiles WHERE user_id = ?", [req.user.id]);
    if (!dp) return res.status(404).json({ error: "Not a driver" });
    const ride = numify(await queryOne(
      `SELECT r.*, u.name AS customer_name, u.profile_image AS customer_image, u.phone AS customer_phone,
              sp.id AS sp_id, sp.shop_name, COALESCE(NULLIF(sp.shop_phone, ''), su.phone) AS shop_phone
       FROM ride_requests r JOIN users u ON r.customer_id = u.id
       LEFT JOIN orders o ON o.id = r.order_id
       LEFT JOIN seller_profiles sp ON sp.user_id = o.seller_id
       LEFT JOIN users su ON su.id = o.seller_id
       WHERE r.driver_id = ? AND r.status IN (${ACTIVE_SQL})
       ORDER BY r.accepted_at DESC LIMIT 1`,
      [dp.id]
    ));
    if (ride) {
      if (ride.order_id && !ride.sp_id) {
        ride.shop_name = ENV.STORE_PICKUP_NAME;
        ride.shop_phone = ENV.STORE_PICKUP_PHONE || ride.shop_phone;
      }
      ride.earning = Math.round((ride.fare || 0) * DRIVER_SHARE);
      delete ride.sp_id;
      delete ride.route_polyline; // served by GET /rides/:id/route
    }
    res.json({ ride: ride || null });
  } catch (err) {
    res.status(200).json({ ride: null });
  }
}

// GET /api/rides/driver/history
export async function driverHistory(req, res) {
  try {
    const dp = await queryOne("SELECT id FROM driver_profiles WHERE user_id = ?", [req.user.id]);
    if (!dp) return res.json({ rides: [] });
    const rides = await query(
      "SELECT * FROM ride_requests WHERE driver_id = ? AND status = 'delivered' ORDER BY delivered_at DESC LIMIT 50",
      [dp.id]
    );
    res.json({ rides: rides.map(numify) });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/rides/driver/earnings
export async function driverEarnings(req, res) {
  try {
    const dp = await queryOne("SELECT balance, total_earnings, total_trips FROM driver_profiles WHERE user_id = ?", [req.user.id]);
    if (!dp) return res.status(404).json({ error: "Not a driver" });
    const earnings = await query(
      "SELECT * FROM driver_earnings WHERE driver_id = (SELECT id FROM driver_profiles WHERE user_id = ?) ORDER BY created_at DESC LIMIT 100",
      [req.user.id]
    );
    res.json({ balance: parseFloat(dp.balance), totalEarnings: parseFloat(dp.total_earnings), totalTrips: dp.total_trips, earnings });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/rides/:rideId/rate  (customer rates driver)
export async function rateDriver(req, res) {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be 1-5" });

    const ride = await queryOne("SELECT * FROM ride_requests WHERE id = ? AND customer_id = ? AND status = 'delivered'",
      [req.params.rideId, req.user.id]);
    if (!ride) return res.status(404).json({ error: "Delivered ride not found" });
    if (ride.driver_rating) return res.status(400).json({ error: "Already rated" });

    await execute("UPDATE ride_requests SET driver_rating = ?, driver_review = ? WHERE id = ?", [rating, comment || "", ride.id]);

    // Update driver avg rating
    const dp = await queryOne("SELECT id, rating, total_reviews FROM driver_profiles WHERE id = ?", [ride.driver_id]);
    if (dp) {
      const newRating = ((parseFloat(dp.rating) * dp.total_reviews) + rating) / (dp.total_reviews + 1);
      await execute("UPDATE driver_profiles SET rating = ?, total_reviews = total_reviews + 1 WHERE id = ?",
        [Math.round(newRating * 100) / 100, dp.id]);

      // Store review
      await execute("INSERT INTO reviews (id, user_id, driver_id, ride_id, rating, comment) VALUES (?, ?, ?, ?, ?, ?)",
        [uuidv4(), req.user.id, dp.id, ride.id, rating, comment || ""]);
    }

    res.json({ message: "Thank you for your rating!" });
  } catch (err) {
    res.status(500).json({ error: "Rating failed" });
  }
}
