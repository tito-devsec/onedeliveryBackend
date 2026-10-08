// node src/config/migrate.js
//
// 1. Runs schema.sql (CREATE TABLE IF NOT EXISTS — safe on fresh + existing DBs)
// 2. Repairs schema drift: CREATE TABLE IF NOT EXISTS does NOT add new columns
//    to tables that already exist, so we explicitly ensure every column that
//    newer app versions rely on. Each ADD COLUMN is checked against
//    information_schema first, so re-running is always safe.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// table → [ [column, definition], ... ]
const ENSURE_COLUMNS = {
  users: [
    ["email_verified", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["phone_verified", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["google_id",      "VARCHAR(64) DEFAULT NULL"],
  ],
  driver_applications: [
    ["national_id",          "VARCHAR(40) DEFAULT ''"],
    ["driver_photo_url",     "TEXT"],
    ["latra_sticker_url",    "TEXT"],
    ["mobile_money_name",    "VARCHAR(120) DEFAULT ''"],
    ["mobile_money_number",  "VARCHAR(20) DEFAULT ''"],
    ["mobile_money_network", "VARCHAR(30) DEFAULT ''"],
    ["home_address",         "TEXT"],
    ["city",                 "VARCHAR(80) DEFAULT 'Dar es Salaam'"],
  ],
  seller_applications: [
    ["owner_name", "VARCHAR(120) DEFAULT ''"],
    ["shop_lat",   "DECIMAL(10,8) DEFAULT NULL"],
    ["shop_lng",   "DECIMAL(11,8) DEFAULT NULL"],
  ],
  driver_profiles: [
    ["mobile_money_number", "VARCHAR(20) DEFAULT ''"],
    ["driver_photo_url",    "TEXT"],
  ],
};

async function ensureColumns(conn, dbName) {
  for (const [table, cols] of Object.entries(ENSURE_COLUMNS)) {
    const [tables] = await conn.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",
      [dbName, table]
    );
    if (!tables.length) continue; // schema.sql will have created it already on fresh DBs

    for (const [col, def] of cols) {
      const [rows] = await conn.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?",
        [dbName, table, col]
      );
      if (!rows.length) {
        console.log(`   ➕ ${table}.${col}`);
        await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`);
      }
    }
  }
}

async function migrate() {
  const dbName = process.env.DB_NAME;
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST || "127.0.0.1",
    port:     parseInt(process.env.DB_PORT || "3306"),
    database: dbName,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    multipleStatements: true,
  });

  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

  console.log("⏳ Running migrations…");
  await conn.query(sql);
  console.log("⏳ Ensuring columns on existing tables…");
  await ensureColumns(conn, dbName);
  console.log("✅ Migrations complete.");
  await conn.end();
}

migrate().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
