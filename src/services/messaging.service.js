/**
 * Messaging Service — Email + SMS
 * ---------------------------------------------------------------------------
 * Push notifications are handled by notification.service.js (Firebase FCM).
 * This module adds OUT-OF-APP channels (email + SMS) so users are also
 * notified on their phone number / email — e.g. when a driver is approved.
 *
 * Both channels are OPTIONAL and disabled until you configure the env vars.
 * Nothing here throws if unconfigured — calls are silent no-ops, so the app
 * keeps working until you're ready to switch them on.
 *
 * EMAIL  → set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM
 *          and `npm i nodemailer`
 * SMS    → set SMS_PROVIDER + provider creds (Africa's Talking / Twilio).
 *          OTP / phone-verification will reuse sendSms() when enabled.
 */
import { ENV } from "../config/env.js";

let transporter = null;
let nodemailerLoaded = false;

async function getTransporter() {
  if (!ENV.SMTP_HOST || !ENV.SMTP_USER) return null;
  if (transporter) return transporter;
  if (nodemailerLoaded) return transporter;
  nodemailerLoaded = true;
  try {
    const nodemailer = (await import("nodemailer")).default;
    transporter = nodemailer.createTransport({
      host: ENV.SMTP_HOST,
      port: ENV.SMTP_PORT,
      secure: ENV.SMTP_PORT === 465,
      auth: { user: ENV.SMTP_USER, pass: ENV.SMTP_PASS },
    });
    return transporter;
  } catch (e) {
    console.warn("[messaging] nodemailer not installed — email disabled.");
    return null;
  }
}

export async function sendEmail({ to, subject, text, html }) {
  try {
    if (!to) return;
    const t = await getTransporter();
    if (!t) return; // email not configured
    await t.sendMail({
      from: ENV.MAIL_FROM || `One Delivery <no-reply@onedelivery.co.tz>`,
      to,
      subject,
      text,
      html: html || `<p>${text}</p>`,
    });
  } catch (e) {
    console.warn("[messaging] sendEmail failed:", e.message);
  }
}

/**
 * sendSms — provider-agnostic SMS sender.
 * Currently a safe no-op unless SMS_PROVIDER is configured. The structure is
 * ready for Africa's Talking (popular in Tanzania) or Twilio. This same
 * function will power phone OTP verification once you enable it.
 */
export async function sendSms({ to, message }) {
  try {
    if (!to) return;

    // Brevo transactional SMS (preferred — same account as email)
    if (ENV.BREVO_API_KEY) {
      const sender = (ENV.SMS_SENDER_ID || "OneDeliver").slice(0, 11);
      // Brevo expects E.164 without the leading "+" for the recipient
      const recipient = String(to).replace(/[^0-9]/g, "");
      const res = await fetch("https://api.brevo.com/v3/transactionalSMS/sms", {
        method: "POST",
        headers: {
          "api-key": ENV.BREVO_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          type: "transactional",
          unicodeEnabled: true,
          sender,
          recipient,
          content: message,
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.warn("[messaging] Brevo SMS failed:", res.status, t.slice(0, 200));
      }
      return;
    }

    if (!ENV.SMS_PROVIDER) return;

    if (ENV.SMS_PROVIDER === "africastalking") {
      // Requires: SMS_AT_USERNAME, SMS_AT_API_KEY, SMS_SENDER_ID
      const res = await fetch("https://api.africastalking.com/version1/messaging", {
        method: "POST",
        headers: {
          apiKey: ENV.SMS_AT_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          username: ENV.SMS_AT_USERNAME,
          to,
          message,
          ...(ENV.SMS_SENDER_ID ? { from: ENV.SMS_SENDER_ID } : {}),
        }),
      });
      await res.json().catch(() => ({}));
      return;
    }

    if (ENV.SMS_PROVIDER === "twilio") {
      // Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
      const auth = Buffer.from(`${ENV.TWILIO_ACCOUNT_SID}:${ENV.TWILIO_AUTH_TOKEN}`).toString("base64");
      await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, From: ENV.TWILIO_FROM, Body: message }),
        }
      );
      return;
    }
  } catch (e) {
    console.warn("[messaging] sendSms failed:", e.message);
  }
}

// Convenience: notify a user across all out-of-app channels at once.
export async function notifyExternally({ email, phone, subject, message }) {
  await Promise.allSettled([
    email ? sendEmail({ to: email, subject, text: message }) : Promise.resolve(),
    phone ? sendSms({ to: phone, message }) : Promise.resolve(),
  ]);
}
