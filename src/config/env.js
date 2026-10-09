import "dotenv/config";

function required(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export const ENV = {
  NODE_ENV:    process.env.NODE_ENV || "development",
  PORT:        parseInt(process.env.PORT || "4000"),
  isProd:      process.env.NODE_ENV === "production",

  JWT_SECRET:          required("JWT_SECRET"),
  JWT_EXPIRES_IN:      process.env.JWT_EXPIRES_IN || "7d",
  JWT_REFRESH_SECRET:  required("JWT_REFRESH_SECRET"),
  JWT_REFRESH_EXPIRES: process.env.JWT_REFRESH_EXPIRES_IN || "30d",

  DB_HOST:     process.env.DB_HOST || "127.0.0.1",
  DB_PORT:     parseInt(process.env.DB_PORT || "3306"),
  DB_NAME:     required("DB_NAME"),
  DB_USER:     required("DB_USER"),
  DB_PASS:     required("DB_PASS"),
  DB_POOL_MIN: parseInt(process.env.DB_POOL_MIN || "2"),
  DB_POOL_MAX: parseInt(process.env.DB_POOL_MAX || "20"),

  REDIS_HOST:     process.env.REDIS_HOST || "127.0.0.1",
  REDIS_PORT:     parseInt(process.env.REDIS_PORT || "6379"),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || null,

  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY:    process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",

  SNIPPE_API_KEY:       required("SNIPPE_API_KEY"),
  SNIPPE_WEBHOOK_SECRET: required("SNIPPE_WEBHOOK_SECRET"),

  FIREBASE_SERVICE_ACCOUNT_PATH: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "",

  // Google sign-in: OAuth "Web client" ID(s) the apps request ID tokens for (comma-separated)
  GOOGLE_CLIENT_IDS: (process.env.GOOGLE_CLIENT_IDS || "").split(",").map(s => s.trim()).filter(Boolean),

  // Server-side Google Maps key (Routes API, Places API (New), Geocoding API)
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || "",
  // Live-traffic routes are billed at the Routes "Pro" rate; off by default
  MAPS_TRAFFIC_AWARE:  process.env.MAPS_TRAFFIC_AWARE === "true",

  // Pickup point for orders whose seller has no shop profile (OneDelivery's own store)
  STORE_PICKUP_LAT:     parseFloat(process.env.STORE_PICKUP_LAT || ""),
  STORE_PICKUP_LNG:     parseFloat(process.env.STORE_PICKUP_LNG || ""),
  STORE_PICKUP_NAME:    process.env.STORE_PICKUP_NAME || "OneDelivery Store",
  STORE_PICKUP_ADDRESS: process.env.STORE_PICKUP_ADDRESS || "",
  STORE_PICKUP_PHONE:   process.env.STORE_PICKUP_PHONE || "",

  // ── Out-of-app notifications (email) — Brevo SMTP ─────────────────────
  SMTP_HOST:  process.env.SMTP_HOST  || "",
  SMTP_PORT:  parseInt(process.env.SMTP_PORT || "587"),
  SMTP_USER:  process.env.SMTP_USER  || "",
  SMTP_PASS:  process.env.SMTP_PASS  || "",
  SMTP_FROM_EMAIL: process.env.SMTP_FROM_EMAIL || "no-reply@onedelivery.co.tz",
  MAIL_FROM:  process.env.MAIL_FROM  || `One Delivery <${process.env.SMTP_FROM_EMAIL || "no-reply@onedelivery.co.tz"}>`,

  // ── SMS / OTP — Brevo transactional SMS (ready to use) ───────────────
  BREVO_API_KEY: process.env.BREVO_API_KEY || "",
  OTP_ENABLED:   process.env.OTP_ENABLED === "true",
  SMS_PROVIDER:  process.env.SMS_PROVIDER || "", // "brevo" | "africastalking" | "twilio"
  SMS_SENDER_ID:   process.env.SMS_SENDER_ID || "OneDeliver",
  SMS_AT_USERNAME: process.env.SMS_AT_USERNAME || "",
  SMS_AT_API_KEY:  process.env.SMS_AT_API_KEY || "",
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN:  process.env.TWILIO_AUTH_TOKEN || "",
  TWILIO_FROM:        process.env.TWILIO_FROM || "",

  CLIENT_URL:   process.env.CLIENT_URL || "https://onedelivery.co.tz",
  API_URL:      process.env.API_URL    || "https://api.onedelivery.co.tz",
  ADMIN_EMAIL:  process.env.ADMIN_EMAIL || "admin@onedelivery.co.tz",

  BASE_SHIPPING_COST: parseFloat(process.env.BASE_SHIPPING_COST || "2000"),
  TAX_RATE:           parseFloat(process.env.TAX_RATE || "0"),

  CORS_ORIGIN: (process.env.CORS_ORIGIN || "https://onedelivery.co.tz,https://admin.onedelivery.co.tz").split(",").map(s => s.trim()),
};
