import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute } from "../config/db.js";
import { sendPushNotification } from "../services/notification.service.js";
import { calcDistanceKm, calcFare, VEHICLE_INFO } from "../services/fare.service.js";
import { setDriverOnline, setDriverOffline, getOnlineDriverIds, getDriverLocation } from "../config/redis.js";

// GET /api/rides/options?pickup_lat&pickup_lng&dropoff_lat&dropoff_lng
export async function getVehicleOptions(req, res) {
  try {
    const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng } = req.query;
    if (!pickup_lat || !dropoff_lat) return res.status(400).json({ error: "Coordinates required" });

    const distKm = calcDistanceKm(+pickup_lat, +pickup_lng, +dropoff_lat, +dropoff_lng);

    // Get available online drivers by type
    const onlineIds = await getOnlineDriverIds();
    const typeCount = {};
    if (onlineIds.length) {
      const drivers = await query(
        `SELECT vehicle_type FROM driver_profiles WHERE user_id IN (${onlineIds.map(() => "?").join(",")}) AND is_approved = 1`,
        onlineIds
      );
      drivers.forEach((d) => { typeCount[d.vehicle_type] = (typeCount[d.vehicle_type] || 0) + 1; });
    }

    const options = Object.values(VEHICLE_INFO).map((v) => ({
      ...v,
      fare:        calcFare(v.id, distKm),
      distanceKm:  Math.round(distKm * 10) / 10,
      available:   typeCount[v.id] || 0,
    }));

    res.json({ options, distanceKm: Math.round(distKm * 10) / 10 });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/rides/request
export async function requestRide(req, res) {
  try {
    const { orderId, vehicleType, pickupLat, pickupLng, pickupAddress, dropoffLat, dropoffLng, dropoffAddress, payerPhone } = req.body;
    if (!vehicleType || !pickupLat || !dropoffLat) return res.status(400).json({ error: "Missing required fields" });
    if (!VEHICLE_INFO[vehicleType]) return res.status(400).json({ error: "Invalid vehicle type" });

    if (orderId) {
      const order = await queryOne("SELECT id, payment_status FROM orders WHERE id = ? AND user_id = ?", [orderId, req.user.id]);
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.payment_status !== "success") return res.status(400).json({ error: "Order payment not confirmed" });
      const existing = await queryOne(
        "SELECT id FROM ride_requests WHERE order_id = ? AND status NOT IN ('cancelled','no_driver')", [orderId]
      );
      if (existing) return res.status(400).json({ error: "Delivery already requested for this order" });
    }

    const distKm = calcDistanceKm(+pickupLat, +pickupLng, +dropoffLat, +dropoffLng);
    const fare   = calcFare(vehicleType, distKm);
    const rideId = uuidv4();

    await execute(
      `INSERT INTO ride_requests (id, customer_id, order_id, vehicle_type, status,
         pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address, fare, distance_km)
       VALUES (?, ?, ?, ?, 'searching', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rideId, req.user.id, orderId || null, vehicleType, +pickupLat, +pickupLng, pickupAddress || "", +dropoffLat, +dropoffLng, dropoffAddress || "", fare, Math.round(distKm * 100) / 100]
    );

    // Notify all online approved drivers of this vehicle type
    const onlineIds = await getOnlineDriverIds();
    if (onlineIds.length) {
      const drivers = await query(
        `SELECT dp.user_id FROM driver_profiles dp WHERE dp.user_id IN (${onlineIds.map(() => "?").join(",")}) AND dp.vehicle_type = ? AND dp.is_approved = 1`,
        [...onlineIds, vehicleType]
      );
      for (const d of drivers) {
        sendPushNotification(d.user_id, {
          title: "🛵 New Delivery Request!",
          body:  `TZS ${fare.toLocaleString()} · ${Math.round(distKm * 10) / 10} km`,
          type:  "new_ride_request",
          sound: true,
          data:  { rideId, screen: "ride_requests" },
        }).catch(() => {});
      }
    }

    sendPushNotification(req.user.id, {
      title: "🔍 Finding a driver…",
      body:  "We're looking for the nearest available driver.",
      type:  "ride_searching",
      data:  { rideId, screen: "track_order" },
    }).catch(() => {});

    res.status(201).json({ rideId, fare, distanceKm: Math.round(distKm * 10) / 10, status: "searching" });
  } catch (err) {
    console.error("requestRide:", err.message);
    res.status(500).json({ error: "Failed to request ride" });
  }
}

// GET /api/rides/:rideId
export async function getRideStatus(req, res) {
  try {
    const ride = await queryOne(
      `SELECT r.*, dp.plate_number, dp.vehicle_type AS driver_vehicle, dp.rating AS driver_rating,
              dp.total_trips, u.name AS driver_name, u.profile_image AS driver_image, u.phone AS driver_phone
       FROM ride_requests r
       LEFT JOIN driver_profiles dp ON r.driver_id = dp.id
       LEFT JOIN users u ON dp.user_id = u.id
       WHERE r.id = ? AND r.customer_id = ?`,
      [req.params.rideId, req.user.id]
    );
    if (!ride) return res.status(404).json({ error: "Ride not found" });

    // Get live driver location from Redis
    if (ride.driver_id) {
      const dp = await queryOne("SELECT user_id FROM driver_profiles WHERE id = ?", [ride.driver_id]);
      if (dp) {
        const loc = await getDriverLocation(dp.user_id);
        if (loc) { ride.driver_lat = parseFloat(loc.lat); ride.driver_lng = parseFloat(loc.lng); }
      }
    }

    res.json({ ride });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/rides/order/:orderId  (get ride for an order)
export async function getRideByOrder(req, res) {
  try {
    const ride = await queryOne(
      `SELECT r.*, dp.plate_number, u.name AS driver_name, u.phone AS driver_phone
       FROM ride_requests r
       LEFT JOIN driver_profiles dp ON r.driver_id = dp.id
       LEFT JOIN users u ON dp.user_id = u.id
       WHERE r.order_id = ? AND r.customer_id = ?
       ORDER BY r.created_at DESC LIMIT 1`,
      [req.params.orderId, req.user.id]
    );
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
    res.json({ rides });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// DELETE /api/rides/:rideId/cancel
export async function cancelRide(req, res) {
  try {
    const ride = await queryOne("SELECT * FROM ride_requests WHERE id = ? AND customer_id = ?", [req.params.rideId, req.user.id]);
    if (!ride) return res.status(404).json({ error: "Ride not found" });
    if (["picked_up","on_the_way","delivered"].includes(ride.status)) {
      return res.status(400).json({ error: "Cannot cancel after pickup" });
    }
    await execute("UPDATE ride_requests SET status = 'cancelled', cancelled_at = NOW(), cancelled_reason = 'Cancelled by customer' WHERE id = ?", [ride.id]);
    if (ride.driver_id) {
      const dp = await queryOne("SELECT user_id FROM driver_profiles WHERE id = ?", [ride.driver_id]);
      if (dp) sendPushNotification(dp.user_id, { title: "❌ Ride Cancelled", body: "Customer cancelled the delivery.", type: "ride_cancelled", data: { rideId: ride.id }, app: "driver" }).catch(() => {});
    }
    res.json({ message: "Ride cancelled" });
  } catch (err) {
    res.status(500).json({ error: "Cancel failed" });
  }
}

// ── DRIVER ENDPOINTS ─────────────────────────────────────────────────────────

// GET /api/rides/driver/available
export async function availableRides(req, res) {
  try {
    const dp = await queryOne("SELECT * FROM driver_profiles WHERE user_id = ?", [req.user.id]);
    if (!dp) return res.status(403).json({ error: "Not registered as driver" });
    if (!dp.is_approved) return res.status(403).json({ error: "Driver not yet approved" });

    const rides = await query(
      `SELECT r.*, u.name AS customer_name, u.profile_image AS customer_image
       FROM ride_requests r JOIN users u ON r.customer_id = u.id
       WHERE r.status = 'searching' AND r.vehicle_type = ?
       ORDER BY r.created_at ASC`,
      [dp.vehicle_type]
    );
    res.json({ rides });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/rides/:rideId/accept
export async function acceptRide(req, res) {
  try {
    const dp = await queryOne("SELECT * FROM driver_profiles WHERE user_id = ? AND is_approved = 1", [req.user.id]);
    if (!dp) return res.status(403).json({ error: "Driver not approved" });

    const ride = await queryOne("SELECT * FROM ride_requests WHERE id = ? AND status = 'searching'", [req.params.rideId]);
    if (!ride) return res.status(400).json({ error: "Ride no longer available" });

    await execute("UPDATE ride_requests SET status = 'accepted', driver_id = ?, accepted_at = NOW() WHERE id = ?", [dp.id, ride.id]);

    sendPushNotification(ride.customer_id, {
      title: "✅ Driver Found!",
      body:  `${req.user.name} accepted your delivery.`,
      type:  "ride_accepted",
      data:  { rideId: ride.id, screen: "track_order" },
    }).catch(() => {});

    res.json({ message: "Ride accepted", rideId: ride.id });
  } catch (err) {
    console.error("acceptRide:", err.message);
    res.status(500).json({ error: "Accept failed" });
  }
}

// PUT /api/rides/:rideId/status  (driver updates status)
export async function updateRideStatus(req, res) {
  try {
    const { status } = req.body;
    const dp = await queryOne("SELECT * FROM driver_profiles WHERE user_id = ?", [req.user.id]);
    if (!dp) return res.status(403).json({ error: "Not a driver" });

    const ride = await queryOne("SELECT * FROM ride_requests WHERE id = ? AND driver_id = ?", [req.params.rideId, dp.id]);
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

    const tsCol = { going_to_shop: "going_to_shop_at", picked_up: "picked_up_at", on_the_way: "on_the_way_at", delivered: "delivered_at", cancelled: "cancelled_at" }[status];
    const tsSet = tsCol ? `, ${tsCol} = NOW()` : "";
    await execute(`UPDATE ride_requests SET status = ? ${tsSet} WHERE id = ?`, [status, ride.id]);

    if (status === "delivered") {
      // Add earnings to driver
      const driverEarning = parseFloat(ride.fare) * 0.85; // 85% to driver
      await execute("UPDATE driver_profiles SET balance = balance + ?, total_earnings = total_earnings + ?, total_trips = total_trips + 1 WHERE id = ?",
        [driverEarning, driverEarning, dp.id]);
      await execute("INSERT INTO driver_earnings (id, driver_id, ride_id, amount, type, description) VALUES (?, ?, ?, ?, 'delivery', ?)",
        [uuidv4(), dp.id, ride.id, driverEarning, `Delivery #${ride.id.slice(-6)}`]);
    }

    const msgs = {
      going_to_shop: { title: "🏪 Driver heading to pickup",  body: "Your driver is going to collect your order." },
      picked_up:     { title: "📦 Order collected!",           body: "Your driver has your order and is coming." },
      on_the_way:    { title: "🚗 Order is on the way!",       body: "Your driver is heading to your location." },
      delivered:     { title: "🎉 Delivered!",                 body: "Your order has arrived. Enjoy!" },
      cancelled:     { title: "❌ Delivery cancelled",         body: "Your driver had to cancel." },
    };
    if (msgs[status]) {
      sendPushNotification(ride.customer_id, { ...msgs[status], type: `ride_${status}`, data: { rideId: ride.id } }).catch(() => {});
    }
    // Notify seller too
    if (ride.order_id && ["picked_up","delivered"].includes(status)) {
      const order = await queryOne("SELECT seller_id FROM orders WHERE id = ?", [ride.order_id]);
      if (order?.seller_id) {
        const smsg = status === "picked_up"
          ? { title: "📦 Order picked up", body: "Driver has collected your order." }
          : { title: "✅ Order Delivered",  body: "Your order was delivered to the customer." };
        sendPushNotification(order.seller_id, { ...smsg, type: `ride_${status}`, data: { rideId: ride.id } }).catch(() => {});
      }
    }

    res.json({ message: `Status updated to ${status}` });
  } catch (err) {
    console.error("updateRideStatus:", err.message);
    res.status(500).json({ error: "Status update failed" });
  }
}

// PUT /api/rides/driver/location
export async function updateDriverLocation(req, res) {
  try {
    const { lat, lng, heading } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
    await execute("UPDATE driver_profiles SET current_lat = ?, current_lng = ?, heading = ?, last_seen = NOW() WHERE user_id = ?",
      [+lat, +lng, heading || 0, req.user.id]);
    await setDriverOnline(req.user.id, +lat, +lng);

    // Emit to Socket.io for live tracking
    if (req.app.get("io")) {
      req.app.get("io").to(`driver:${req.user.id}`).emit("driver:location", { lat: +lat, lng: +lng, heading: heading || 0 });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// PUT /api/rides/driver/online
export async function toggleOnline(req, res) {
  try {
    const { isOnline } = req.body;
    if (isOnline) {
      await execute("UPDATE driver_profiles SET is_online = 1, last_seen = NOW() WHERE user_id = ?", [req.user.id]);
    } else {
      await execute("UPDATE driver_profiles SET is_online = 0 WHERE user_id = ?", [req.user.id]);
      await setDriverOffline(req.user.id);
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
    const ride = await queryOne(
      `SELECT r.*, u.name AS customer_name, u.profile_image AS customer_image, u.phone AS customer_phone
       FROM ride_requests r JOIN users u ON r.customer_id = u.id
       WHERE r.driver_id = ? AND r.status IN ('accepted','going_to_shop','picked_up','on_the_way')
       ORDER BY r.accepted_at DESC LIMIT 1`,
      [dp.id]
    );
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
    res.json({ rides });
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
