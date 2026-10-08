// node src/config/seed.js
// Seeds default CATEGORIES and PACKAGES. Safe to re-run (INSERT IGNORE).
import { v4 as uuidv4 } from "uuid";
import mysql from "mysql2/promise";
import "dotenv/config";

const CATEGORIES = [
  { name: "Electronics",  icon: "hardware-chip-outline",  color: "#3B82F6", sort: 1 },
  { name: "Fashion",      icon: "shirt-outline",           color: "#EC4899", sort: 2 },
  { name: "Food",         icon: "fast-food-outline",       color: "#EF4444", sort: 3 },
  { name: "Beauty",       icon: "sparkles-outline",        color: "#A855F7", sort: 4 },
  { name: "Sports",       icon: "fitness-outline",         color: "#22C55E", sort: 5 },
  { name: "Books",        icon: "book-outline",            color: "#F59E0B", sort: 6 },
  { name: "Furniture",    icon: "bed-outline",             color: "#14B8A6", sort: 7 },
  { name: "Toys",         icon: "game-controller-outline", color: "#F97316", sort: 8 },
];

const PACKAGES = [
  // Customers
  { id: "customer_free",    name: "Free",             type: "customer", price: 0,      days: 36500, free: 1, sort: 1,
    features: ["Browse & order products", "Standard delivery fees"] },
  { id: "customer_premium", name: "Customer Premium", type: "customer", price: 10000,  days: 30,    free: 0, sort: 2,
    features: ["Free shipping on all orders", "Priority support"] },
  { id: "customer_vip",     name: "Customer VIP",     type: "customer", price: 25000,  days: 30,    free: 0, sort: 3,
    features: ["Free shipping", "Priority delivery dispatch", "VIP support"] },
  // Sellers
  { id: "seller_free",      name: "Seller Free",      type: "seller",   price: 0,      days: 36500, free: 1, sort: 1,
    features: ["List up to 20 products", "Standard placement"] },
  { id: "seller_pro",       name: "Seller Pro",       type: "seller",   price: 30000,  days: 30,    free: 0, sort: 2,
    features: ["Unlimited products", "Eligible for FEATURED slots on the home screen", "Sales analytics"] },
  { id: "seller_business",  name: "Seller Business",  type: "seller",   price: 75000,  days: 30,    free: 0, sort: 3,
    features: ["Everything in Pro", "Priority featured placement", "Reduced commission", "Dedicated support"] },
];

async function seed() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "127.0.0.1",
    port: parseInt(process.env.DB_PORT || "3306"),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
  });

  console.log("⏳ Seeding categories…");
  for (const c of CATEGORIES) {
    await conn.execute(
      "INSERT IGNORE INTO categories (id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)",
      [uuidv4(), c.name, c.icon, c.color, c.sort]
    );
  }

  console.log("⏳ Seeding packages…");
  for (const p of PACKAGES) {
    await conn.execute(
      `INSERT INTO packages (id, name, type, price, duration_days, features, is_free, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), features = VALUES(features)`,
      [p.id, p.name, p.type, p.price, p.days, JSON.stringify(p.features), p.free, p.sort]
    );
  }

  console.log("✅ Seed complete.");
  await conn.end();
}

seed().catch((e) => { console.error("Seed failed:", e.message); process.exit(1); });
