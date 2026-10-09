import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { ENV } from "../config/env.js";
import { queryOne, execute } from "../config/db.js";
import { setDriverOffline } from "../config/redis.js";
import { isValidLatLng } from "../services/geo.js";
import { recordDriverLocation, broadcastDriverLocation, forgetDriverWrites } from "../services/tracking.service.js";

export function setupSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin:      ENV.CORS_ORIGIN,
      credentials: true,
    },
    pingTimeout:  60000,
    pingInterval: 25000,
    transports: ["websocket", "polling"],
  });

  // ── JWT Auth middleware ───────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.slice(7);
      if (!token) return next(new Error("No token"));

      let payload;
      try {
        payload = jwt.verify(token, ENV.JWT_SECRET);
      } catch {
        return next(new Error("Invalid token"));
      }

      const user = await queryOne(
        "SELECT id, name, role, is_active FROM users WHERE id = ?",
        [payload.sub]
      );
      if (!user || !user.is_active) return next(new Error("Unauthorized"));

      socket.user = user;
      next();
    } catch (err) {
      next(new Error("Auth error"));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.user;
    console.log(`[Socket] Connected: ${user.name} (${user.role}) [${socket.id}]`);

    // Each user joins their own room for targeted push
    socket.join(`user:${user.id}`);

    // ── Driver: join driver room and go online ──────────────────────────
    if (user.role === "driver") {
      socket.join(`driver:${user.id}`);

      socket.on("driver:online", async ({ lat, lng, heading } = {}) => {
        try {
          await execute("UPDATE driver_profiles SET is_online = 1 WHERE user_id = ?", [user.id]);
          lat = Number(lat); lng = Number(lng);
          if (isValidLatLng(lat, lng)) {
            forgetDriverWrites(user.id);
            await recordDriverLocation(user.id, lat, lng, Number(heading) || 0);
          }
          socket.to("admin_room").emit("driver:status", { driverId: user.id, online: true });
        } catch (e) { console.error("driver:online", e.message); }
      });

      // GPS fix from the driver app. The delivery it belongs to is looked up on the
      // server (tracking.service), so a payload's rideId is never trusted.
      socket.on("driver:location", async ({ lat, lng, heading } = {}) => {
        try {
          lat = Number(lat); lng = Number(lng);
          if (!isValidLatLng(lat, lng)) return;
          heading = Number(heading) || 0;
          await recordDriverLocation(user.id, lat, lng, heading);
          await broadcastDriverLocation(io, user.id, { lat, lng, heading });

          // Admin can see all driver positions
          io.to("admin_room").emit("driver:position", { driverId: user.id, lat, lng, heading });
        } catch (e) { console.error("driver:location", e.message); }
      });

      socket.on("driver:offline", async () => {
        try {
          await execute("UPDATE driver_profiles SET is_online = 0 WHERE user_id = ?", [user.id]);
          await setDriverOffline(user.id);
          socket.to("admin_room").emit("driver:status", { driverId: user.id, online: false });
        } catch (e) { console.error("driver:offline", e.message); }
      });
    }

    // ── Admin: join admin room ────────────────────────────────────────────
    if (user.role === "admin") {
      socket.join("admin_room");
    }

    // ── Chat: join conversation rooms ─────────────────────────────────────
    socket.on("chat:join", async ({ conversationId }) => {
      try {
        const part = await queryOne(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
          [conversationId, user.id]
        );
        if (part) {
          socket.join(`conv:${conversationId}`);
          socket.emit("chat:joined", { conversationId });
        }
      } catch (e) { console.error("chat:join", e.message); }
    });

    socket.on("chat:leave", ({ conversationId }) => {
      socket.leave(`conv:${conversationId}`);
    });

    // Typing indicators
    socket.on("chat:typing", ({ conversationId }) => {
      socket.to(`conv:${conversationId}`).emit("chat:typing", { userId: user.id, name: user.name });
    });

    socket.on("chat:stop_typing", ({ conversationId }) => {
      socket.to(`conv:${conversationId}`).emit("chat:stop_typing", { userId: user.id });
    });

    // Live tracking updates go to each user's own room (user:<id>), so the old
    // track:join / track:leave events from the apps need no room of their own.
    socket.on("track:join", () => {});
    socket.on("track:leave", () => {});

    // ── Disconnect ────────────────────────────────────────────────────────
    // A driver is NOT taken offline when the socket drops: the driver app keeps sending
    // its position over HTTPS from a background service (e.g. while Google Maps is
    // navigating). Dispatch only uses drivers whose last fix is under 2 minutes old,
    // and the jobs take silent drivers offline after 5 minutes.
    socket.on("disconnect", () => {
      console.log(`[Socket] Disconnected: ${user.name}`);
    });
  });

  return io;
}
