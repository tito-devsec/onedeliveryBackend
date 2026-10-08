import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { uploadDoc, uploadImage } from "../middleware/upload.middleware.js";
import multer from "multer";
import {
  applyAsSeller, applicationStatus, getSellerProfile, updateSellerProfile,
  sellerDashboard, applyAsDriver, getDriverProfile, updateDriverProfile,
  driverApplicationStatus,
  savePushToken, getNotifications,
} from "../controllers/seller.controller.js";
import {
  getWishlist, addToWishlist, removeFromWishlist,
  getAddresses, addAddress, updateAddress, deleteAddress,
} from "../controllers/user.controller.js";
import { query } from "../config/db.js";

const router = Router();

const driverUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Seller application ────────────────────────────────────────────────────────
router.post("/seller/apply",        authenticate, uploadDoc.single("id_document"), applyAsSeller);
router.get ("/seller/application",  authenticate, applicationStatus);
router.get ("/seller/profile",      authenticate, getSellerProfile);
router.put ("/seller/profile",      authenticate, uploadImage.single("shop_image"), updateSellerProfile);
router.get ("/seller/dashboard",    authenticate, sellerDashboard);

// ── Driver application ────────────────────────────────────────────────────────
router.post("/driver/apply",        authenticate,
  driverUpload.fields([
    { name: "id_document",       maxCount: 1 },
    { name: "license_document",  maxCount: 1 },
    { name: "vehicle_photo",     maxCount: 1 },
    { name: "driver_photo",      maxCount: 1 },
    { name: "latra_sticker",     maxCount: 1 },
  ]),
  applyAsDriver
);
router.get("/driver/profile",       authenticate, getDriverProfile);
router.get("/driver/application",   authenticate, driverApplicationStatus);
router.put("/driver/profile",       authenticate, updateDriverProfile);

// ── Notifications ─────────────────────────────────────────────────────────────
router.post("/notifications/token", authenticate, savePushToken);
router.get ("/notifications",       authenticate, getNotifications);

// ── Wishlist ──────────────────────────────────────────────────────────────────
router.get   ("/users/wishlist",              authenticate, getWishlist);
router.post  ("/users/wishlist/:productId",   authenticate, addToWishlist);
router.delete("/users/wishlist/:productId",   authenticate, removeFromWishlist);

// ── Addresses ─────────────────────────────────────────────────────────────────
router.get   ("/users/addresses",     authenticate, getAddresses);
router.post  ("/users/addresses",     authenticate, addAddress);
router.put   ("/users/addresses/:id", authenticate, updateAddress);
router.delete("/users/addresses/:id", authenticate, deleteAddress);

// ── Packages (public) ─────────────────────────────────────────────────────────
router.get("/packages", async (req, res) => {
  try {
    const packages = await query("SELECT * FROM packages WHERE is_active = 1 ORDER BY type, sort_order");
    res.json({ packages });
  } catch { res.status(500).json({ error: "Internal server error" }); }
});

// ── User subscription ─────────────────────────────────────────────────────────
router.get("/users/subscription", authenticate, async (req, res) => {
  try {
    const { queryOne } = await import("../config/db.js");
    const sub = await queryOne(
      "SELECT s.*, p.name AS package_name, p.features FROM subscriptions s LEFT JOIN packages p ON s.package_id = p.id WHERE s.user_id = ? AND s.status = 'active' ORDER BY s.created_at DESC LIMIT 1",
      [req.user.id]
    );
    res.json({ subscription: sub || null });
  } catch { res.status(500).json({ error: "Internal server error" }); }
});

export default router;
