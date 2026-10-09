import { execute, query } from "../config/db.js";
import { setDriverOffline } from "../config/redis.js";
import { sendPushNotification } from "../services/notification.service.js";
import { escalateDispatch, closeOffers, withdrawDriverOffers } from "../services/dispatch.service.js";

// Run all cleanup jobs — call this on a schedule (setInterval or cron)

// ── Expire stale 'searching' rides (10 min without a driver accepting) ────────
export async function expireStaleRides(io) {
  try {
    const stale = await query(
      "SELECT id, customer_id FROM ride_requests WHERE status = 'searching' AND COALESCE(searching_since, created_at) < NOW() - INTERVAL 10 MINUTE"
    );
    for (const ride of stale) {
      const r = await execute("UPDATE ride_requests SET status = 'no_driver' WHERE id = ? AND status = 'searching'", [ride.id]);
      if (!r.affectedRows) continue;
      await closeOffers(io, ride.id, "expired");
      io?.to(`user:${ride.customer_id}`).emit("ride:status", { rideId: ride.id, status: "no_driver" });
      sendPushNotification(ride.customer_id, {
        title: "😔 No driver found",
        body:  "We couldn't find a nearby driver. Please try again or choose a different vehicle type.",
        type:  "no_driver",
        data:  { rideId: ride.id, screen: "track_order" },
      }).catch(() => {});
    }
    if (stale.length) console.log(`[jobs] Expired ${stale.length} stale rides`);
  } catch (e) { console.error("[jobs] expireStaleRides:", e.message); }
}

// ── Expire subscriptions ───────────────────────────────────────────────────────
export async function expireSubscriptions() {
  try {
    const { affectedRows } = await execute(
      "UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND expires_at < NOW()"
    );
    if (affectedRows) console.log(`[jobs] Expired ${affectedRows} subscriptions`);
  } catch (e) { console.error("[jobs] expireSubscriptions:", e.message); }
}

// ── Mark drivers offline if last_seen > 5 min ─────────────────────────────────
export async function markDriversOffline(io) {
  try {
    const silent = await query(
      "SELECT user_id FROM driver_profiles WHERE is_online = 1 AND (last_seen IS NULL OR last_seen < NOW() - INTERVAL 5 MINUTE)"
    );
    if (!silent.length) return;
    await execute(
      "UPDATE driver_profiles SET is_online = 0 WHERE is_online = 1 AND (last_seen IS NULL OR last_seen < NOW() - INTERVAL 5 MINUTE)"
    );
    for (const d of silent) {
      await setDriverOffline(d.user_id).catch(() => {});
      // Their open offers and prices go back to the search
      await withdrawDriverOffers(io, { driverUserId: d.user_id }).catch(() => {});
    }
    console.log(`[jobs] Marked ${silent.length} drivers offline (stale heartbeat)`);
  } catch (e) { console.error("[jobs] markDriversOffline:", e.message); }
}

// ── Purge old processed webhooks ──────────────────────────────────────────────
export async function purgeWebhooks() {
  try {
    await execute("DELETE FROM processed_webhooks WHERE created_at < NOW() - INTERVAL 7 DAY");
  } catch (e) { console.error("[jobs] purgeWebhooks:", e.message); }
}

// ── Un-feature expired featured products ──────────────────────────────────────
export async function expireFeaturedProducts() {
  try {
    const { affectedRows } = await execute(
      "UPDATE products SET is_featured = 0 WHERE is_featured = 1 AND featured_until IS NOT NULL AND featured_until < NOW()"
    );
    if (affectedRows) console.log(`[jobs] Un-featured ${affectedRows} expired products`);
  } catch (e) { console.error("[jobs] expireFeaturedProducts:", e.message); }
}

// ── Start all background jobs ─────────────────────────────────────────────────
export function startJobs(io) {
  // Every 10 seconds: widen the driver search for rides nobody has accepted yet
  setInterval(() => escalateDispatch(io), 10 * 1000);

  // Every minute / few minutes
  setInterval(() => expireStaleRides(io), 60 * 1000);
  setInterval(() => markDriversOffline(io), 2 * 60 * 1000);

  // Every 10 minutes
  setInterval(expireSubscriptions,  10 * 60 * 1000);
  setInterval(expireFeaturedProducts, 10 * 60 * 1000);

  // Every hour
  setInterval(purgeWebhooks,        60 * 60 * 1000);

  console.log("✅ Background jobs started");
}
