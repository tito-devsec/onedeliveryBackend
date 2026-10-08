import mysql from "mysql2/promise";
import { ENV } from "./env.js";

let pool;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:               ENV.DB_HOST,
      port:               ENV.DB_PORT,
      database:           ENV.DB_NAME,
      user:               ENV.DB_USER,
      password:           ENV.DB_PASS,
      waitForConnections: true,
      connectionLimit:    ENV.DB_POOL_MAX,
      queueLimit:         0,
      enableKeepAlive:    true,
      keepAliveInitialDelay: 0,
      timezone:           "+00:00",
      charset:            "utf8mb4",
    });
  }
  return pool;
}

// Shorthand helpers
export async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

export async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

// Transaction helper
export async function withTransaction(fn) {
  const conn = await getPool().getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function connectDB() {
  try {
    const conn = await getPool().getConnection();
    await conn.ping();
    conn.release();
    console.log(`✅ MySQL connected → ${ENV.DB_HOST}:${ENV.DB_PORT}/${ENV.DB_NAME}`);
  } catch (err) {
    console.error("❌ MySQL connection failed:", err.message);
    process.exit(1);
  }
}
