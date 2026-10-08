import jwt from "jsonwebtoken";
import { ENV } from "../config/env.js";
import { queryOne } from "../config/db.js";

// Attach req.user from JWT
export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }
    const token = header.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, ENV.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const user = await queryOne(
      "SELECT id, name, email, phone, role, profile_image, is_active FROM users WHERE id = ?",
      [payload.sub]
    );

    if (!user) return res.status(401).json({ error: "User not found" });
    if (!user.is_active) return res.status(403).json({ error: "Account suspended" });

    req.user = user;
    next();
  } catch (err) {
    console.error("authenticate:", err.message);
    res.status(500).json({ error: "Authentication error" });
  }
}

// Role guard factory
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

export const requireAdmin  = requireRole("admin");
export const requireSeller = requireRole("seller", "admin");
export const requireDriver = requireRole("driver");
