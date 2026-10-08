import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { ENV } from "../config/env.js";
import { queryOne, execute } from "../config/db.js";
import { setDriverOnline, setDriverOffline } from "../config/redis.js";

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

      socket.on("driver:online", async ({ lat, lng }) => {
        try {
          await execute(
            "UPDATE driver_profiles SET is_online = 1, current_lat = ?, current_lng = ?, last_seen = NOW() WHERE user_id = ?",
            [lat || null, lng || null, user.id]
          );
          await setDriverOnline(user.id, lat || 0, lng || 0);
          socket.to("admin_room").emit("driver:status", { driverId: user.id, online: true });
        } catch (e) { console.error("driver:online", e.message); }
      });

      socket.on("driver:location", async ({ lat, lng, heading, rideId }) => {
        try {
          await execute(
            "UPDATE driver_profiles SET current_lat = ?, current_lng = ?, heading = ?, last_seen = NOW() WHERE user_id = ?",
            [lat, lng, heading || 0, user.id]
          );
          await setDriverOnline(user.id, lat, lng);

          // Broadcast live location to customer tracking that ride
          if (rideId) {
            const ride = await queryOne("SELECT customer_id FROM ride_requests WHERE id = ?", [rideId]);
            if (ride) {
              io.to(`user:${ride.customer_id}`).emit("driver:location_update", { lat, lng, heading, rideId });
            }
            // Also broadcast to seller if order linked
            const orderRide = await queryOne("SELECT o.seller_id FROM ride_requests r JOIN orders o ON r.order_id = o.id WHERE r.id = ?", [rideId]);
            if (orderRide?.seller_id) {
              io.to(`user:${orderRide.seller_id}`).emit("driver:location_update", { lat, lng, heading, rideId });
            }
          }

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

    // ── Track order room (customer joins to get live updates) ─────────────
    socket.on("track:join", ({ rideId }) => {
      socket.join(`ride:${rideId}`);
    });

    socket.on("track:leave", ({ rideId }) => {
      socket.leave(`ride:${rideId}`);
    });

    // ── Disconnect ────────────────────────────────────────────────────────
    socket.on("disconnect", async () => {
      console.log(`[Socket] Disconnected: ${user.name}`);
      // Driver: if no other sockets, go offline
      if (user.role === "driver") {
        const sockets = await io.in(`driver:${user.id}`).fetchSockets();
        if (sockets.length === 0) {
          try {
            await execute("UPDATE driver_profiles SET is_online = 0 WHERE user_id = ?", [user.id]);
            await setDriverOffline(user.id);
          } catch (e) { /* non-critical */ }
        }
      }
    });
  });

  return io;
}
