/**
 * Snippe Payment Gateway Service
 * Tanzanian payment gateway: M-Pesa, Airtel Money, Mixx, Halotel, Card
 * Docs: https://snippe.sh
 */
import crypto from "crypto";
import { ENV } from "../config/env.js";

const SNIPPE_BASE = "https://api.snippe.sh/v1";

function headers(idempotencyKey = null) {
  const h = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ENV.SNIPPE_API_KEY}`,
  };
  if (idempotencyKey) h["Idempotency-Key"] = String(idempotencyKey).slice(0, 30);
  return h;
}

function normalizePhone(phone) {
  let p = String(phone).replace(/[\s\-+]/g, "");
  if (p.startsWith("0")) p = "255" + p.slice(1);
  if (!p.startsWith("255")) p = "255" + p;
  return p;
}

// ── Mobile Money Payment ──────────────────────────────────────────────────────
export async function initiateMobilePayment({ amount, phoneNumber, customer, orderId, idempotencyKey }) {
  const res = await fetch(`${SNIPPE_BASE}/payments`, {
    method: "POST",
    headers: headers(idempotencyKey),
    body: JSON.stringify({
      payment_type: "mobile",
      details: { amount: Math.round(amount), currency: "TZS" },
      phone_number: normalizePhone(phoneNumber),
      customer: {
        firstname: customer.firstname || customer.name?.split(" ")[0] || "Customer",
        lastname:  customer.lastname  || customer.name?.split(" ").slice(1).join(" ") || "User",
        email:     customer.email || "customer@onedelivery.co.tz",
      },
      webhook_url: `${ENV.API_URL}/payment/webhook`,
      metadata: { order_id: orderId },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.status !== "success") {
    return { success: false, message: data.message || `Payment failed (${res.status})` };
  }
  return { success: true, reference: data.data.reference, status: data.data.status, expiresAt: data.data.expires_at };
}

// ── Card Payment ──────────────────────────────────────────────────────────────
export async function initiateCardPayment({ amount, customer, orderId, redirectUrl, cancelUrl, idempotencyKey }) {
  const res = await fetch(`${SNIPPE_BASE}/payments`, {
    method: "POST",
    headers: headers(idempotencyKey),
    body: JSON.stringify({
      payment_type: "card",
      details: {
        amount: Math.round(amount), currency: "TZS",
        redirect_url: redirectUrl || `${ENV.CLIENT_URL}/payment/success`,
        cancel_url:   cancelUrl   || `${ENV.CLIENT_URL}/payment/cancel`,
      },
      customer: {
        firstname: customer.firstname || "Customer",
        lastname:  customer.lastname  || "User",
        email:     customer.email,
        address:   customer.address  || "Dar es Salaam",
        city:      customer.city     || "Dar es Salaam",
        state:     customer.state    || "DSM",
        postcode:  customer.postcode || "14101",
        country:   "TZ",
      },
      webhook_url: `${ENV.API_URL}/payment/webhook`,
      metadata: { order_id: orderId },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.status !== "success") {
    return { success: false, message: data.message || "Card payment failed" };
  }
  return {
    success: true,
    reference: data.data.reference,
    paymentUrl: data.data.payment_url,
    paymentToken: data.data.payment_token,
    expiresAt: data.data.expires_at,
  };
}

// ── Delivery Fee Payment ──────────────────────────────────────────────────────
export async function initiateDeliveryPayment({ amount, phoneNumber, customer, rideId, idempotencyKey }) {
  const res = await fetch(`${SNIPPE_BASE}/payments`, {
    method: "POST",
    headers: headers(idempotencyKey),
    body: JSON.stringify({
      payment_type: "mobile",
      details: { amount: Math.round(amount), currency: "TZS" },
      phone_number: normalizePhone(phoneNumber),
      customer: {
        firstname: customer.firstname || "Customer",
        lastname:  customer.lastname  || "User",
        email:     customer.email || "customer@onedelivery.co.tz",
      },
      webhook_url: `${ENV.API_URL}/payment/webhook`,
      metadata: { ride_id: rideId, type: "delivery_fee" },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.status !== "success") {
    return { success: false, message: data.message || "Delivery payment failed" };
  }
  return { success: true, reference: data.data.reference, expiresAt: data.data.expires_at };
}

// ── Package/Subscription Payment ─────────────────────────────────────────────
export async function initiatePackagePayment({ amount, phoneNumber, customer, packageId, userId, idempotencyKey }) {
  const res = await fetch(`${SNIPPE_BASE}/payments`, {
    method: "POST",
    headers: headers(idempotencyKey),
    body: JSON.stringify({
      payment_type: "mobile",
      details: { amount: Math.round(amount), currency: "TZS" },
      phone_number: normalizePhone(phoneNumber),
      customer: {
        firstname: customer.firstname || "User",
        lastname:  customer.lastname  || "",
        email:     customer.email || "user@onedelivery.co.tz",
      },
      webhook_url: `${ENV.API_URL}/payment/webhook`,
      metadata: { package_id: packageId, user_id: userId, type: "package" },
    }),
  });
  const data = await res.json();
  if (!res.ok || data.status !== "success") {
    return { success: false, message: data.message || "Package payment failed" };
  }
  return { success: true, reference: data.data.reference };
}

// ── Payout / Withdrawal via Snippe ───────────────────────────────────────────
export async function initiatePayout({ amount, phoneNumber, recipientName, description, idempotencyKey }) {
  const res = await fetch(`${SNIPPE_BASE}/payouts`, {
    method: "POST",
    headers: headers(idempotencyKey),
    body: JSON.stringify({
      amount: Math.round(amount),
      currency: "TZS",
      phone_number: normalizePhone(phoneNumber),
      recipient_name: recipientName,
      description: description || "OneDelivery withdrawal",
    }),
  });
  const data = await res.json();
  if (!res.ok || data.status !== "success") {
    return { success: false, message: data.message || "Payout failed" };
  }
  return { success: true, reference: data.data.reference, status: data.data.status };
}

// ── Webhook Signature Verification ───────────────────────────────────────────
export function verifyWebhookSignature(rawBody, reqHeaders) {
  const secret = ENV.SNIPPE_WEBHOOK_SECRET;
  if (!secret) return true;
  const timestamp = reqHeaders["x-webhook-timestamp"];
  const signature = reqHeaders["x-webhook-signature"];
  if (!timestamp || !signature) return false;
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (age > 300) return false; // replay protection: 5 min
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

export const MOBILE_PROVIDERS = [
  { id: "mpesa",   name: "M-Pesa",      color: "#00A859", prefix: ["076","077"] },
  { id: "airtel",  name: "Airtel Money", color: "#FF0000", prefix: ["078","079"] },
  { id: "mixx",    name: "Mixx by Yas",  color: "#0099CC", prefix: ["071","072","073"] },
  { id: "halotel", name: "HaloPesa",     color: "#F7941D", prefix: ["062","061"] },
];

export function detectProvider(phone) {
  const p = String(phone).replace(/[\s\-+]/g, "");
  const local = p.startsWith("255") ? "0" + p.slice(3) : p;
  const prefix = local.slice(0, 3);
  return MOBILE_PROVIDERS.find((x) => x.prefix.includes(prefix))?.id || null;
}
