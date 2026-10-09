import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { redisRateLimit } from "../config/redis.js";
import { autocomplete, placeDetails, reverseGeocode, computeRoute, mapsEnabled } from "../services/maps.service.js";
import { toLatLng } from "../services/geo.js";

// Address search and routes for the apps. The Google key stays on the server, and
// every call needs a signed-in user so the billing can't be run up anonymously.
const router = Router();

async function limit(req, res, next) {
  const over = await redisRateLimit(`rl:maps:${req.user.id}`, 90, 60).catch(() => false);
  if (over) return res.status(429).json({ error: "Too many map requests. Please wait a moment." });
  next();
}

// Express 4 doesn't catch errors thrown by async handlers
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error("[maps route]", e.message);
    res.status(500).json({ error: "Map service error" });
  });

const sessionOf = (req) => String(req.query.session || "").slice(0, 64) || undefined;

// GET /api/maps/autocomplete?input=&lat=&lng=&session=
router.get("/autocomplete", authenticate, limit, wrap(async (req, res) => {
  const near = toLatLng(req.query.lat, req.query.lng);
  const predictions = await autocomplete(String(req.query.input || ""), { near, sessionToken: sessionOf(req) });
  res.json({ predictions, enabled: mapsEnabled() });
}));

// GET /api/maps/place/:placeId?session=
router.get("/place/:placeId", authenticate, limit, wrap(async (req, res) => {
  const place = await placeDetails(req.params.placeId, { sessionToken: sessionOf(req) });
  if (!place) return res.status(404).json({ error: "Place not found" });
  res.json({ place });
}));

// GET /api/maps/reverse?lat=&lng=
router.get("/reverse", authenticate, limit, wrap(async (req, res) => {
  const p = toLatLng(req.query.lat, req.query.lng);
  if (!p) return res.status(400).json({ error: "lat and lng required" });
  const geo = await reverseGeocode(p.lat, p.lng);
  res.json({ address: geo?.address || null });
}));

// GET /api/maps/route?from=lat,lng&to=lat,lng
router.get("/route", authenticate, limit, wrap(async (req, res) => {
  const [flat, flng] = String(req.query.from || "").split(",");
  const [tlat, tlng] = String(req.query.to || "").split(",");
  const from = toLatLng(flat, flng), to = toLatLng(tlat, tlng);
  if (!from || !to) return res.status(400).json({ error: "from and to required as lat,lng" });
  const route = await computeRoute(from, to);
  res.json({ route });
}));

export default router;
