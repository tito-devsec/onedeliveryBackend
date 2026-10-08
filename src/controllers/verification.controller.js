/**
 * Verification Controller — Email & SMS OTP via Brevo
 * ---------------------------------------------------------------------------
 * Sends a 6-digit code to the logged-in user's email or phone and verifies it.
 * Codes are stored in Redis with a 10-minute TTL. This does NOT gate login
 * (kept optional on purpose) — it lets you verify contact details and is the
 * foundation for full phone-OTP sign-in later.
 *
 *   POST /api/auth/send-verification   { channel: "email" | "sms" }
 *   POST /api/auth/verify-code         { channel, code }
 */
import { queryOne, execute } from "../config/db.js";
import { getRedis } from "../config/redis.js";
import { sendEmail, sendSms } from "../services/messaging.service.js";

const TTL = 600; // 10 minutes
const key = (userId, channel) => `verify:${channel}:${userId}`;

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// POST /api/auth/send-verification
export async function sendVerification(req, res) {
  try {
    const { channel = "email" } = req.body;
    if (!["email", "sms"].includes(channel)) {
      return res.status(400).json({ error: "channel must be 'email' or 'sms'" });
    }

    const user = await queryOne("SELECT name, email, phone FROM users WHERE id = ?", [req.user.id]);
    if (!user) return res.status(404).json({ error: "User not found" });

    const dest = channel === "email" ? user.email : user.phone;
    if (!dest) return res.status(400).json({ error: `No ${channel} on file for this account` });

    const code = genCode();
    // Basic rate-limit: 1 active code per channel
    await getRedis().setex(key(req.user.id, channel), TTL, code);

    if (channel === "email") {
      await sendEmail({
        to: user.email,
        subject: "Your One Delivery verification code",
        text: `Your One Delivery verification code is ${code}. It expires in 10 minutes.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#283A7A">One Delivery</h2>
          <p>Your verification code is:</p>
          <p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#F97316">${code}</p>
          <p style="color:#667085">This code expires in 10 minutes. — From Anywhere To You.</p>
        </div>`,
      });
    } else {
      await sendSms({
        to: user.phone,
        message: `One Delivery: your verification code is ${code} (valid 10 min).`,
      });
    }

    res.json({ message: `Verification code sent via ${channel}` });
  } catch (err) {
    console.error("sendVerification:", err.message);
    res.status(500).json({ error: "Could not send verification code" });
  }
}

// POST /api/auth/verify-code
export async function verifyCode(req, res) {
  try {
    const { channel = "email", code } = req.body;
    if (!code) return res.status(400).json({ error: "code required" });

    const stored = await getRedis().get(key(req.user.id, channel));
    if (!stored) return res.status(400).json({ error: "Code expired. Request a new one." });
    if (String(stored) !== String(code)) return res.status(400).json({ error: "Invalid code" });

    await getRedis().del(key(req.user.id, channel));
    const col = channel === "email" ? "email_verified" : "phone_verified";
    await execute(`UPDATE users SET ${col} = 1 WHERE id = ?`, [req.user.id]);

    res.json({ message: `${channel} verified`, verified: true });
  } catch (err) {
    console.error("verifyCode:", err.message);
    res.status(500).json({ error: "Verification failed" });
  }
}
