import "dotenv/config";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import rateLimit from "express-rate-limit";

import { ENV } from "./config/env.js";
import { connectDB } from "./config/db.js";
import { getRedis } from "./config/redis.js";
import { setupSocket } from "./socket/index.js";
import { startJobs } from "./jobs/index.js";

import {
  requestId, sanitizeInput, sqlInjectionGuard,
  enforceHttps, auditLogger,
} from "./middleware/security.middleware.js";

import authRoutes    from "./routes/auth.route.js";
import productRoutes from "./routes/product.route.js";
import orderRoutes   from "./routes/order.route.js";
import paymentRoutes from "./routes/payment.route.js";
import rideRoutes    from "./routes/ride.route.js";
import chatRoutes    from "./routes/chat.route.js";
import cartRoutes    from "./routes/cart.route.js";
import reviewRoutes  from "./routes/review.route.js";
import userRoutes    from "./routes/user.route.js";
import adminRoutes   from "./routes/admin.route.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = http.createServer(app);

// ── Trust proxy (Nginx) ───────────────────────────────────────────────────────
app.set("trust proxy", 1);

// ── HTTPS redirect in production ──────────────────────────────────────────────
app.use(enforceHttps);

// ── Request ID ────────────────────────────────────────────────────────────────
app.use(requestId);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    contentSecurityPolicy: false,
  })
);

// ── Compression ───────────────────────────────────────────────────────────────
app.use(compression());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ENV.CORS_ORIGIN.includes(origin) || !ENV.isProd) {
        cb(null, true);
      } else {
        cb(new Error("CORS: origin not allowed"));
      }
    },
    credentials: true,
    methods: ["GET","POST","PUT","DELETE","PATCH","OPTIONS"],
    allowedHeaders: ["Authorization","Content-Type","X-Request-ID","Idempotency-Key"],
    maxAge: 86400,
  })
);

// ── Global rate limit ─────────────────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: ENV.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
    max:      ENV.RATE_LIMIT_MAX       || 300,
    standardHeaders: true,
    legacyHeaders:   false,
    skip: (req) => req.path === "/api/health",
    message: { error: "Too many requests, please try again later" },
  })
);

// ── CRITICAL: Raw body for Snippe webhook HMAC ────────────────────────────────
app.use(
  "/api/payment/webhook",
  express.raw({ type: "application/json", limit: "100kb" }),
  (req, _res, next) => {
    req.rawBody = req.body.toString("utf8");
    req.body    = JSON.parse(req.rawBody);
    next();
  }
);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: false, limit: "50kb" }));

// ── Input sanitization ────────────────────────────────────────────────────────
app.use(sanitizeInput);
app.use(sqlInjectionGuard);

// ── Audit logging ─────────────────────────────────────────────────────────────
app.use(auditLogger);

// ── Health check (before auth) ────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  let dbOk = false, redisOk = false;
  try { const { queryOne } = await import("./config/db.js"); await queryOne("SELECT 1"); dbOk = true; } catch {}
  try { await getRedis().ping(); redisOk = true; } catch {}
  res.json({
    status: dbOk && redisOk ? "ok" : "degraded",
    app: "OneDelivery API v2",
    env: ENV.NODE_ENV,
    db: dbOk ? "connected" : "error",
    redis: redisOk ? "connected" : "error",
    ts: new Date().toISOString(),
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth",     authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders",   orderRoutes);
app.use("/api/payment",  paymentRoutes);
app.use("/api/rides",    rideRoutes);
app.use("/api/chat",     chatRoutes);
app.use("/api/cart",     cartRoutes);
app.use("/api/reviews",  reviewRoutes);
app.use("/api",          userRoutes);    // /api/seller/*, /api/driver/*, /api/notifications/*
app.use("/api/admin",    adminRoutes);

// ── Serve admin SPA in production ────────────────────────────────────────────
if (ENV.isProd) {
  const adminDist = path.join(__dirname, "../../admin/dist");
  app.use(express.static(adminDist));
  app.get(/^(?!\/api).*/, (_req, res) =>
    res.sendFile(path.join(adminDist, "index.html"))
  );
}

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  const rid = req.requestId || "unknown";
  console.error(`[Error][${rid}]`, err.message);
  const msg = ENV.isProd ? "An error occurred. Please try again." : err.message;
  res.status(err.status || 500).json({ error: msg, requestId: rid });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = setupSocket(httpServer);
app.set("io", io);

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  await connectDB();
  getRedis(); // init Redis connection
  startJobs();
  httpServer.listen(ENV.PORT, "0.0.0.0", () => {
    console.log(`✅ OneDelivery API v2 running on port ${ENV.PORT} [${ENV.NODE_ENV}]`);
    console.log(`   HTTP:      http://localhost:${ENV.PORT}`);
    console.log(`   WebSocket: ws://localhost:${ENV.PORT}`);
  });
}

boot().catch((err) => {
  console.error("❌ Boot failed:", err.message);
  process.exit(1);
});
