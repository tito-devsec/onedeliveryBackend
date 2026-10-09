import Redis from "ioredis";
import { ENV } from "./env.js";

let redis;

export function getRedis() {
  if (!redis) {
    redis = new Redis({
      host:            ENV.REDIS_HOST,
      port:            ENV.REDIS_PORT,
      password:        ENV.REDIS_PASSWORD || undefined,
      retryStrategy:   (times) => Math.min(times * 100, 3000),
      maxRetriesPerRequest: 3,
      lazyConnect:     false,
      keepAlive:       10000,
    });

    redis.on("connect",    () => console.log("✅ Redis connected"));
    redis.on("error",      (e) => console.error("❌ Redis error:", e.message));
    redis.on("reconnecting", () => console.log("🔄 Redis reconnecting…"));
  }
  return redis;
}

// ── Convenience wrappers ──────────────────────────────────────────────────────

export async function cacheGet(key) {
  try {
    const v = await getRedis().get(key);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

export async function cacheSet(key, value, ttlSeconds = 300) {
  try {
    await getRedis().setex(key, ttlSeconds, JSON.stringify(value));
  } catch { /* non-critical */ }
}

export async function cacheDel(...keys) {
  try {
    if (keys.length) await getRedis().del(...keys);
  } catch { /* non-critical */ }
}

// Online drivers set: track which drivers are live
export async function setDriverOnline(driverId, lat, lng, heading = 0) {
  const r = getRedis();
  await r.hset(`driver:loc:${driverId}`, { lat, lng, heading, ts: Date.now() });
  await r.sadd("drivers:online", driverId);
  await r.expire(`driver:loc:${driverId}`, 120); // expire if no heartbeat 2 min
}

export async function setDriverOffline(driverId) {
  const r = getRedis();
  await r.srem("drivers:online", driverId);
  await r.del(`driver:loc:${driverId}`);
}

export async function getOnlineDriverIds() {
  return getRedis().smembers("drivers:online");
}

export async function getDriverLocation(driverId) {
  return getRedis().hgetall(`driver:loc:${driverId}`);
}

// Idempotency key check
export async function checkIdempotency(key) {
  const r = getRedis();
  const existing = await r.get(`idem:${key}`);
  if (existing) return JSON.parse(existing);
  return null;
}

export async function setIdempotency(key, result, ttlSeconds = 86400) {
  await getRedis().setex(`idem:${key}`, ttlSeconds, JSON.stringify(result));
}

// Rate-limit helper (sliding window via Redis)
export async function redisRateLimit(key, maxRequests, windowSeconds) {
  const r = getRedis();
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const pipeline = r.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, `${now}`);
  pipeline.zcard(key);
  pipeline.expire(key, windowSeconds + 1);
  const results = await pipeline.exec();
  const count = results[2][1];
  return count > maxRequests;
}
