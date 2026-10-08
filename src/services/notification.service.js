/**
 * Push Notification Service — Firebase Cloud Messaging (FCM)
 * Falls back to Expo Push API if expo_push_token is set
 */
import fs from "fs";
import { query, queryOne, execute } from "../config/db.js";
import { ENV } from "../config/env.js";
import { v4 as uuidv4 } from "uuid";

// Android notification channel both apps create with the OneDelivery chime
const ANDROID_CHANNEL_ID = "onedelivery_alerts";

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

// ── Send push to a single user ────────────────────────────────────────────────
export async function sendPushNotification(userId, { title, body, type, data = {}, sound = true }) {
  try {
    const user = await queryOne("SELECT expo_push_token, fcm_token FROM users WHERE id = ?", [userId]);
    if (!user) return;

    // Store notification in DB
    await execute(
      "INSERT INTO notifications (id, user_id, title, body, type, data) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv4(), userId, title, body, type || "general", JSON.stringify(data)]
    );

    // Try FCM first
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

    // Fallback: Expo Push
    if (user.expo_push_token?.startsWith("ExponentPushToken") || user.expo_push_token?.startsWith("ExpoPushToken")) {
      const resp = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: user.expo_push_token,
          title, body,
          sound: sound ? "default" : null,
          priority: "high",
          channelId: ANDROID_CHANNEL_ID,
          data: { type, ...data },
        }),
        signal: AbortSignal.timeout(5000),
      });
      const result = await resp.json();
      if (result?.data?.details?.error === "DeviceNotRegistered") {
        await execute("UPDATE users SET expo_push_token = NULL WHERE id = ?", [userId]);
      }
    }
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
    "SELECT id FROM users WHERE role = ? AND is_active = 1 AND (fcm_token IS NOT NULL OR expo_push_token IS NOT NULL)",
    [role]
  );
  await broadcastNotification(users.map((u) => u.id), notification);
}

// ── Save FCM token ────────────────────────────────────────────────────────────
export async function saveFcmToken(userId, token) {
  await execute("UPDATE users SET fcm_token = ? WHERE id = ?", [token, userId]);
}

// ── Save Expo token ───────────────────────────────────────────────────────────
export async function saveExpoToken(userId, token) {
  await execute("UPDATE users SET expo_push_token = ? WHERE id = ?", [token, userId]);
}
