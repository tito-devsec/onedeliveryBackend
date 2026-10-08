/**
 * Seed / promote an admin user.
 *
 * Usage:
 *   node src/config/seed-admin.js <email> <password> [name]
 *   # or rely on env: ADMIN_EMAIL + ADMIN_PASSWORD
 *
 * If the email already exists, the account is promoted to role=admin and the
 * password is reset. Otherwise a new admin user is created. Run AFTER db:migrate.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { connectDB, queryOne, execute } from "./db.js";

async function seedAdmin() {
  const email = (process.argv[2] || process.env.ADMIN_EMAIL || "").toLowerCase().trim();
  const password = process.argv[3] || process.env.ADMIN_PASSWORD || "";
  const name = process.argv[4] || "One Delivery Admin";

  if (!email || !password) {
    console.error("Usage: node src/config/seed-admin.js <email> <password> [name]");
    console.error("   or set ADMIN_EMAIL and ADMIN_PASSWORD in .env");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  await connectDB();
  const hash = await bcrypt.hash(password, 12);

  const existing = await queryOne("SELECT id FROM users WHERE email = ?", [email]);
  if (existing) {
    await execute(
      "UPDATE users SET role = 'admin', password_hash = ?, is_active = 1 WHERE id = ?",
      [hash, existing.id]
    );
    console.log(`✅ Promoted existing user to admin: ${email}`);
  } else {
    await execute(
      "INSERT INTO users (id, name, email, phone, password_hash, role, is_active, email_verified) VALUES (?, ?, ?, '', ?, 'admin', 1, 1)",
      [uuidv4(), name, email, hash]
    );
    console.log(`✅ Created admin user: ${email}`);
  }
  console.log("   You can now sign in to the admin panel with this email + password.");
  process.exit(0);
}

seedAdmin().catch((e) => {
  console.error("Seed admin failed:", e.message);
  process.exit(1);
});
