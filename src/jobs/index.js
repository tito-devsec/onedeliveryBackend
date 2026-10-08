import { execute, query } from "../config/db.js";
import { sendPushNotification } from "../services/notification.service.js";

// Run all cleanup jobs — call this on a schedule (setInterval or cron)

// ── Expire stale 'searching' rides (older than 10 min with no driver) ─────────
export async function expireStaleRides() {
  try {
    const stale = await query(
      "SELECT id, customer_id FROM ride_requests WHERE status = 'searching' AND created_at < NOW() - INTERVAL 10 MINUTE"
    );
    for (const ride of stale) {
      await execute("UPDATE ride_requests SET status = 'no_driver' WHERE id = ?", [ride.id]);
      sendPushNotification(ride.customer_id, {
        title: "😔 No driver found",
        body:  "We couldn't find a nearby driver. Please try again or choose a different vehicle type.",
        type:  "no_driver",
        data:  { rideId: ride.id },
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
export async function markDriversOffline() {
  try {
    const { affectedRows } = await execute(
      "UPDATE driver_profiles SET is_online = 0 WHERE is_online = 1 AND last_seen < NOW() - INTERVAL 5 MINUTE"
    );
    if (affectedRows) console.log(`[jobs] Marked ${affectedRows} drivers offline (stale heartbeat)`);
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
export function startJobs() {
  // Every 2 minutes
  setInterval(expireStaleRides,     2 * 60 * 1000);
  setInterval(markDriversOffline,   3 * 60 * 1000);

  // Every 10 minutes
  setInterval(expireSubscriptions,  10 * 60 * 1000);
  setInterval(expireFeaturedProducts, 10 * 60 * 1000);

  // Every hour
  setInterval(purgeWebhooks,        60 * 60 * 1000);

  console.log("✅ Background jobs started");
}
