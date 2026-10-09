/**
 * Push Notification Service
 * Expo push tokens are stored per device + app (push_tokens), so a user signed in
 * on several phones, or in both the shop and driver apps, gets every notification
 * meant for each. Legacy single tokens (users.expo_push_token / fcm_token) from
 * older app versions are still used.
 */
import fs from "fs";
import { query, queryOne, execute } from "../config/db.js";
import { ENV } from "../config/env.js";
import { v4 as uuidv4 } from "uuid";

// Android notification channel both apps create with the OneDelivery chime
const ANDROID_CHANNEL_ID = "onedelivery_alerts";

// Which app a notification type is for; types not listed go to every app the user has
const APP_FOR_TYPE = {
  driver_approved: "driver", driver_rejected: "driver", new_ride_request: "driver",
  seller_approved: "shop", seller_rejected: "shop", product_approved: "shop", product_rejected: "shop",
  order_processing: "shop", order_shipped: "shop", order_delivered: "shop", order_cancelled: "shop",
  order_confirmed: "shop", payment_failed: "shop", delivery_paid: "shop",
  package_activated: "shop", package_assigned: "shop",
  ride_searching: "shop", ride_accepted: "shop", no_driver: "shop", ride_going_to_shop: "shop",
  ride_picked_up: "shop", ride_on_the_way: "shop", ride_delivered: "shop", ride_cancelled: "shop",
  ride_released: "shop", ride_driver_assigned: "shop", shop_location_missing: "shop",
  ride_counter: "shop", ride_assigned: "driver", delivery_payment_failed: "shop", ride_paid: "driver",
};

let firebaseApp = null;

async function getFirebase() {
  if (firebaseApp) return firebaseApp;
  if (!ENV.FIREBASE_SERVICE_ACCOUNT_PATH || !fs.existsSync(ENV.FIREBASE_SERVICE_ACCOUNT_PATH)) {
    return null;
  }
  try {
    const admin = (await import("firebase-admin")).default;
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(fs.readFileSync(ENV.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    firebaseApp = admin;
    return firebaseApp;
  } catch (e) {
    console.error("Firebase init failed:", e.message);
    return null;
  }
}

const isExpoToken = (t) => typeof t === "string" && (t.startsWith("ExponentPushToken") || t.startsWith("ExpoPushToken"));

async function forgetExpoToken(token) {
  await execute("DELETE FROM push_tokens WHERE token = ?", [token]);
  await execute("UPDATE users SET expo_push_token = NULL WHERE expo_push_token = ?", [token]);
}

// Expo accepts up to 100 messages per request; tickets come back in the same order
async function sendExpoMessages(messages) {
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const resp = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(chunk),
      signal: AbortSignal.timeout(8000),
    });
    const result = await resp.json().catch(() => null);
    const tickets = Array.isArray(result?.data) ? result.data : [];
    for (const [k, ticket] of tickets.entries()) {
      if (ticket?.details?.error === "DeviceNotRegistered") await forgetExpoToken(chunk[k].to);
      else if (ticket?.status === "error") console.error("Expo push:", ticket.message);
    }
  }
}

// ── Send push to a single user ────────────────────────────────────────────────
// `app`: "shop" | "driver" to target one app, null for every app; defaults by type.
export async function sendPushNotification(userId, { title, body, type, data = {}, sound = true, app }) {
  try {
    const user = await queryOne("SELECT expo_push_token, fcm_token FROM users WHERE id = ?", [userId]);
    if (!user) return;

    // Store notification in DB
    await execute(
      "INSERT INTO notifications (id, user_id, title, body, type, data) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv4(), userId, title, body, type || "general", JSON.stringify(data)]
    );

    // Legacy FCM token (clients that registered a raw FCM token)
    if (user.fcm_token) {
      const admin = await getFirebase();
      if (admin) {
        try {
          await admin.messaging().send({
            token: user.fcm_token,
            notification: { title, body },
            data: { type: type || "general", ...Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])) },
            android: { priority: "high", notification: { sound: sound ? "default" : null, channelId: ANDROID_CHANNEL_ID } },
            apns:    { payload: { aps: { sound: sound ? "default" : null, badge: 1 } } },
          });
          return;
        } catch (fcmErr) {
          if (fcmErr.code === "messaging/registration-token-not-registered") {
            await execute("UPDATE users SET fcm_token = NULL WHERE id = ?", [userId]);
          }
        }
      }
    }

    // Expo push: every device/app this user is signed in on, plus the legacy column
    const target = app === undefined ? (APP_FOR_TYPE[type] || null) : app;
    const rows = await query("SELECT token, app FROM push_tokens WHERE user_id = ?", [userId]);
    const tokens = new Map(rows.map((r) => [r.token, r.app]));
    if (user.expo_push_token && !tokens.has(user.expo_push_token)) tokens.set(user.expo_push_token, null);

    // Tokens without an app (older app versions) can't be told apart, so they always get it
    const recipients = [...tokens]
      .filter(([token, tokenApp]) => isExpoToken(token) && (!target || !tokenApp || tokenApp === target))
      .map(([token]) => token);
    if (!recipients.length) return;

    await sendExpoMessages(recipients.map((to) => ({
      to,
      title, body,
      sound: sound ? "default" : null,
      priority: "high",
      channelId: ANDROID_CHANNEL_ID,
      data: { type, ...data },
    })));
  } catch (err) {
    console.error("sendPushNotification:", err.message);
  }
}

// ── Broadcast to multiple users ───────────────────────────────────────────────
export async function broadcastNotification(userIds, notification) {
  await Promise.allSettled(userIds.map((id) => sendPushNotification(id, notification)));
}

// ── Notify all users with a given role ───────────────────────────────────────
export async function notifyByRole(role, notification) {
  const users = await query(
    `SELECT u.id FROM users u WHERE u.role = ? AND u.is_active = 1 AND (u.fcm_token IS NOT NULL
       OR u.expo_push_token IS NOT NULL OR EXISTS (SELECT 1 FROM push_tokens t WHERE t.user_id = u.id))`,
    [role]
  );
  await broadcastNotification(users.map((u) => u.id), notification);
}

// ── Save FCM token ────────────────────────────────────────────────────────────
export async function saveFcmToken(userId, token) {
  await execute("UPDATE users SET fcm_token = ? WHERE id = ?", [token, userId]);
}

// ── Save Expo token (one row per device; a device that signs in to another account moves over) ──
export async function saveExpoToken(userId, token, app = null, platform = null) {
  await execute(
    `INSERT INTO push_tokens (token, user_id, app, platform) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), app = VALUES(app), platform = VALUES(platform)`,
    [token, userId, app, platform]
  );
}

// ── Remove a device's token (sign-out) ────────────────────────────────────────
export async function removeExpoToken(userId, token) {
  await execute("DELETE FROM push_tokens WHERE token = ? AND user_id = ?", [token, userId]);
  await execute("UPDATE users SET expo_push_token = NULL WHERE id = ? AND expo_push_token = ?", [userId, token]);
}
