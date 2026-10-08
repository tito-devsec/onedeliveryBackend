import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute } from "../config/db.js";
import { ENV } from "../config/env.js";

function signAccess(userId, role) {
  return jwt.sign({ sub: userId, role }, ENV.JWT_SECRET, { expiresIn: ENV.JWT_EXPIRES_IN });
}
function signRefresh(userId) {
  return jwt.sign({ sub: userId }, ENV.JWT_REFRESH_SECRET, { expiresIn: ENV.JWT_REFRESH_EXPIRES });
}

// POST /api/auth/register
export async function register(req, res) {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "name, email and password required" });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const existing = await queryOne("SELECT id FROM users WHERE email = ?", [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 12);
    const id   = uuidv4();
    await execute(
      "INSERT INTO users (id, name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?, 'customer')",
      [id, name.trim(), email.toLowerCase(), phone || "", hash]
    );

    const accessToken  = signAccess(id, "customer");
    const refreshToken = signRefresh(id);
    const rtHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const rtId   = uuidv4();
    const rtExp  = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await execute("INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
      [rtId, id, rtHash, rtExp]);

    res.status(201).json({
      message: "Account created",
      user: { id, name: name.trim(), email: email.toLowerCase(), role: "customer" },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error("register:", err.message);
    res.status(500).json({ error: "Registration failed" });
  }
}

// POST /api/auth/login
export async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const user = await queryOne(
      "SELECT id, name, email, phone, role, profile_image, password_hash, is_active FROM users WHERE email = ?",
      [email.toLowerCase()]
    );
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (!user.is_active) return res.status(403).json({ error: "Account suspended" });
    if (!user.password_hash) return res.status(401).json({ error: "Please use OAuth login" });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const accessToken  = signAccess(user.id, user.role);
    const refreshToken = signRefresh(user.id);
    const rtHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const rtId   = uuidv4();
    const rtExp  = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await execute("INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
      [rtId, user.id, rtHash, rtExp]);

    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, profile_image: user.profile_image },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error("login:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
}

// POST /api/auth/refresh
export async function refresh(req, res) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: "Refresh token required" });

    let payload;
    try {
      payload = jwt.verify(refreshToken, ENV.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    const rtHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const stored = await queryOne(
      "SELECT id FROM refresh_tokens WHERE token_hash = ? AND user_id = ? AND expires_at > NOW()",
      [rtHash, payload.sub]
    );
    if (!stored) return res.status(401).json({ error: "Refresh token expired or revoked" });

    const user = await queryOne("SELECT id, role FROM users WHERE id = ?", [payload.sub]);
    if (!user) return res.status(401).json({ error: "User not found" });

    // Rotate token
    await execute("DELETE FROM refresh_tokens WHERE id = ?", [stored.id]);
    const newAccess  = signAccess(user.id, user.role);
    const newRefresh = signRefresh(user.id);
    const newHash = crypto.createHash("sha256").update(newRefresh).digest("hex");
    const newId   = uuidv4();
    const newExp  = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await execute("INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
      [newId, user.id, newHash, newExp]);

    res.json({ accessToken: newAccess, refreshToken: newRefresh });
  } catch (err) {
    console.error("refresh:", err.message);
    res.status(500).json({ error: "Token refresh failed" });
  }
}

// POST /api/auth/logout
export async function logout(req, res) {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const rtHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
      await execute("DELETE FROM refresh_tokens WHERE token_hash = ?", [rtHash]);
    }
    res.json({ message: "Logged out" });
  } catch (err) {
    res.json({ message: "Logged out" });
  }
}

// GET /api/auth/me
export async function getMe(req, res) {
  try {
    const user = await queryOne(
      "SELECT id, name, email, phone, role, profile_image, created_at FROM users WHERE id = ?",
      [req.user.id]
    );
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch profile" });
  }
}

// PUT /api/auth/me  (name/phone update + optional profile image upload via multipart field "avatar")
export async function updateMe(req, res) {
  try {
    const { name, phone } = req.body || {};
    const fields = [];
    const vals   = [];
    if (name)  { fields.push("name = ?");  vals.push(name.trim()); }
    if (phone) { fields.push("phone = ?"); vals.push(phone); }
    if (req.file) {
      const { uploadBuffer } = await import("../services/upload.service.js");
      try {
        const r = await uploadBuffer(req.file.buffer, "avatars");
        fields.push("profile_image = ?"); vals.push(r.secure_url);
      } catch (upErr) {
        console.error("updateMe avatar upload:", upErr.message);
        return res.status(502).json({ error: "Profile image upload failed. Try again." });
      }
    }
    if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(req.user.id);
    await execute(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, vals);
    const user = await queryOne(
      "SELECT id, name, email, phone, role, profile_image FROM users WHERE id = ?", [req.user.id]
    );
    res.json({ message: "Profile updated", user });
  } catch (err) {
    console.error("updateMe:", err.message);
    res.status(500).json({ error: "Update failed" });
  }
}

// PUT /api/auth/change-password
export async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both passwords required" });
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be 8+ characters" });
    const user = await queryOne("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Current password incorrect" });
    const hash = await bcrypt.hash(newPassword, 12);
    await execute("UPDATE users SET password_hash = ? WHERE id = ?", [hash, req.user.id]);
    // Invalidate all refresh tokens
    await execute("DELETE FROM refresh_tokens WHERE user_id = ?", [req.user.id]);
    res.json({ message: "Password changed. Please log in again." });
  } catch (err) {
    res.status(500).json({ error: "Password change failed" });
  }
}
