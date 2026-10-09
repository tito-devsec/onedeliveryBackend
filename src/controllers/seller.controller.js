import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute } from "../config/db.js";
import { uploadBuffer } from "../services/upload.service.js";
import { saveExpoToken, saveFcmToken, removeExpoToken } from "../services/notification.service.js";
import { isValidLatLng } from "../services/geo.js";

// POST /api/seller/apply
export async function applyAsSeller(req, res) {
  try {
    const { business_name, business_description, business_phone, business_address, business_type, tin_number,
            owner_name, shop_lat, shop_lng } = req.body;
    if (!business_name) return res.status(400).json({ error: "Business name required" });

    const existing = await queryOne("SELECT id, status FROM seller_applications WHERE user_id = ?", [req.user.id]);
    if (existing) {
      if (existing.status === "pending") return res.status(400).json({ error: "Application already pending" });
      if (existing.status === "approved") return res.status(400).json({ error: "Already a seller" });
    }

    let id_document_url = "";
    if (req.file) {
      const result = await uploadBuffer(req.file.buffer, "seller_docs");
      id_document_url = result.secure_url;
    }

    const appId = uuidv4();
    if (existing) {
      await execute(
        `UPDATE seller_applications SET business_name=?, business_description=?, business_phone=?,
         business_address=?, business_type=?, tin_number=?, owner_name=?, shop_lat=?, shop_lng=?,
         id_document_url=?, status='pending', rejection_reason='', reviewed_at=NULL
         WHERE user_id=?`,
        [business_name, business_description || "", business_phone || "", business_address || "",
         business_type || "general", tin_number || "", owner_name || "",
         shop_lat != null && shop_lat !== "" ? parseFloat(shop_lat) : null,
         shop_lng != null && shop_lng !== "" ? parseFloat(shop_lng) : null,
         id_document_url || existing.id_document_url, req.user.id]
      );
    } else {
      await execute(
        `INSERT INTO seller_applications (id, user_id, business_name, business_description, business_phone,
         business_address, business_type, tin_number, owner_name, shop_lat, shop_lng, id_document_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [appId, req.user.id, business_name, business_description || "", business_phone || "",
         business_address || "", business_type || "general", tin_number || "", owner_name || "",
         shop_lat != null && shop_lat !== "" ? parseFloat(shop_lat) : null,
         shop_lng != null && shop_lng !== "" ? parseFloat(shop_lng) : null,
         id_document_url]
      );
    }

    res.status(201).json({ message: "Application submitted. Admin will review within 24–48 hours." });
  } catch (err) {
    console.error("applyAsSeller:", err.message);
    res.status(500).json({ error: "Application failed" });
  }
}

// GET /api/seller/application/status
export async function applicationStatus(req, res) {
  try {
    const app = await queryOne("SELECT * FROM seller_applications WHERE user_id = ?", [req.user.id]);
    res.json({ application: app || null });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/seller/profile
export async function getSellerProfile(req, res) {
  try {
    const profile = await queryOne("SELECT * FROM seller_profiles WHERE user_id = ?", [req.user.id]);
    if (!profile) return res.status(404).json({ error: "Seller profile not found" });
    res.json({ profile });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// PUT /api/seller/profile
export async function updateSellerProfile(req, res) {
  try {
    const { shop_name, shop_description, shop_phone, shop_address,
            bank_name, bank_account_name, bank_account_number, mobile_money_number } = req.body;
    let { shop_lat, shop_lng } = req.body;
    // The shop location is the pickup point drivers navigate to, so it must be a real pair
    if (shop_lat !== undefined || shop_lng !== undefined) {
      shop_lat = parseFloat(shop_lat); shop_lng = parseFloat(shop_lng);
      if (!isValidLatLng(shop_lat, shop_lng)) return res.status(400).json({ error: "Invalid shop location" });
    }
    const fields = []; const vals = [];
    const map = { shop_name, shop_description, shop_phone, shop_address, shop_lat, shop_lng,
                  bank_name, bank_account_name, bank_account_number, mobile_money_number };
    for (const [k, v] of Object.entries(map)) {
      if (v !== undefined) { fields.push(`${k} = ?`); vals.push(v); }
    }
    if (req.file) {
      const r = await uploadBuffer(req.file.buffer, "shops");
      fields.push("shop_image = ?"); vals.push(r.secure_url);
    }
    if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(req.user.id);
    const r = await execute(`UPDATE seller_profiles SET ${fields.join(", ")} WHERE user_id = ?`, vals);
    if (!r.affectedRows) return res.status(404).json({ error: "Seller profile not found" });
    res.json({ message: "Profile updated" });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
}

// GET /api/seller/dashboard
export async function sellerDashboard(req, res) {
  try {
    const [totalOrders, revenue, pendingOrders, pendingProducts, balance] = await Promise.all([
      queryOne("SELECT COUNT(*) AS c FROM orders WHERE seller_id = ? AND payment_status = 'success'", [req.user.id]),
      queryOne("SELECT COALESCE(SUM(total_price),0) AS c FROM orders WHERE seller_id = ? AND payment_status = 'success'", [req.user.id]),
      queryOne("SELECT COUNT(*) AS c FROM orders WHERE seller_id = ? AND status IN ('pending','processing')", [req.user.id]),
      queryOne("SELECT COUNT(*) AS c FROM products WHERE seller_id = ? AND status = 'pending'", [req.user.id]),
      queryOne("SELECT balance, total_sales FROM seller_profiles WHERE user_id = ?", [req.user.id]),
    ]);
    res.json({
      totalOrders:    totalOrders.c,
      totalRevenue:   parseFloat(revenue.c),
      pendingOrders:  pendingOrders.c,
      pendingProducts: pendingProducts.c,
      balance:        parseFloat(balance?.balance || 0),
      totalSales:     parseFloat(balance?.total_sales || 0),
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/driver/apply
export async function applyAsDriver(req, res) {
  try {
    const {
      vehicle_type, plate_number, vehicle_color, vehicle_model, license_number,
      national_id, mobile_money_name, mobile_money_number, mobile_money_network,
      address, city,
    } = req.body;
    if (!vehicle_type || !plate_number) return res.status(400).json({ error: "vehicle_type and plate_number required" });
    if (!["bodaboda","bajaj","pickup","toyo"].includes(vehicle_type)) {
      return res.status(400).json({ error: "Invalid vehicle type" });
    }

    const existing = await queryOne("SELECT id, status FROM driver_applications WHERE user_id = ?", [req.user.id]);
    if (existing?.status === "pending") return res.status(400).json({ error: "Application already pending" });
    if (existing?.status === "approved") return res.status(400).json({ error: "Already a driver" });

    // Handle multiple file uploads (clear error if Cloudinary rejects/unconfigured)
    const urls = { id_document: "", license_document: "", vehicle_photo: "", driver_photo: "", latra_sticker: "" };
    try {
      for (const field of Object.keys(urls)) {
        if (req.files?.[field]?.[0]) {
          const r = await uploadBuffer(req.files[field][0].buffer, "driver_docs");
          urls[field] = r.secure_url;
        }
      }
    } catch (upErr) {
      console.error("applyAsDriver upload:", upErr.message);
      return res.status(502).json({ error: "Document upload failed. Please retry — if it persists, contact support." });
    }

    if (existing) {
      await execute(
        `UPDATE driver_applications SET vehicle_type=?, plate_number=?, vehicle_color=?, vehicle_model=?,
         license_number=?, national_id=?, id_document_url=?, license_document_url=?, vehicle_photo_url=?,
         driver_photo_url=?, latra_sticker_url=?, mobile_money_name=?, mobile_money_number=?,
         mobile_money_network=?, home_address=?, city=?,
         status='pending', rejection_reason='', reviewed_at=NULL WHERE user_id=?`,
        [vehicle_type, plate_number, vehicle_color || "", vehicle_model || "", license_number || "",
         national_id || "", urls.id_document, urls.license_document, urls.vehicle_photo,
         urls.driver_photo, urls.latra_sticker, mobile_money_name || "", mobile_money_number || "",
         mobile_money_network || "", address || "", city || "Dar es Salaam", req.user.id]
      );
    } else {
      await execute(
        `INSERT INTO driver_applications (id, user_id, vehicle_type, plate_number, vehicle_color, vehicle_model,
         license_number, national_id, id_document_url, license_document_url, vehicle_photo_url,
         driver_photo_url, latra_sticker_url, mobile_money_name, mobile_money_number, mobile_money_network,
         home_address, city)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.user.id, vehicle_type, plate_number, vehicle_color || "", vehicle_model || "",
         license_number || "", national_id || "", urls.id_document, urls.license_document, urls.vehicle_photo,
         urls.driver_photo, urls.latra_sticker, mobile_money_name || "", mobile_money_number || "",
         mobile_money_network || "", address || "", city || "Dar es Salaam"]
      );
    }

    res.status(201).json({ message: "Driver application submitted. Admin will review your documents." });
  } catch (err) {
    console.error("applyAsDriver:", err.message);
    res.status(500).json({ error: "Application failed" });
  }
}

// GET /api/driver/application  (driver application status — used by the driver app)
export async function driverApplicationStatus(req, res) {
  try {
    const app = await queryOne("SELECT * FROM driver_applications WHERE user_id = ?", [req.user.id]);
    res.json({ application: app || null });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/driver/profile
export async function getDriverProfile(req, res) {
  try {
    const profile = await queryOne("SELECT * FROM driver_profiles WHERE user_id = ?", [req.user.id]);
    if (!profile) return res.status(404).json({ error: "Driver profile not found" });
    res.json({ profile });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// PUT /api/driver/profile
export async function updateDriverProfile(req, res) {
  try {
    const { bank_name, bank_account_name, bank_account_number, mobile_money_number } = req.body;
    const fields = []; const vals = [];
    const map = { bank_name, bank_account_name, bank_account_number, mobile_money_number };
    for (const [k, v] of Object.entries(map)) {
      if (v !== undefined) { fields.push(`${k} = ?`); vals.push(v); }
    }
    if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(req.user.id);
    await execute(`UPDATE driver_profiles SET ${fields.join(", ")} WHERE user_id = ?`, vals);
    res.json({ message: "Profile updated" });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
}

// POST /api/notifications/token  { token, type?, app?: "shop" | "driver", platform? }
export async function savePushToken(req, res) {
  try {
    const { token, type = "expo", app, platform } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });
    if (type === "fcm") {
      await saveFcmToken(req.user.id, token);
    } else {
      await saveExpoToken(
        req.user.id,
        String(token).slice(0, 255),
        ["shop", "driver"].includes(app) ? app : null,
        platform ? String(platform).slice(0, 10) : null
      );
    }
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: "Save failed" });
  }
}

// DELETE /api/notifications/token  { token } — the apps call this when signing out
export async function deletePushToken(req, res) {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "Token required" });
    await removeExpoToken(req.user.id, token);
    res.json({ removed: true });
  } catch (err) {
    res.status(500).json({ error: "Remove failed" });
  }
}

// GET /api/notifications
export async function getNotifications(req, res) {
  try {
    const notifs = await query(
      "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
      [req.user.id]
    );
    await execute("UPDATE notifications SET is_read = 1 WHERE user_id = ?", [req.user.id]);
    res.json({ notifications: notifs });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}
