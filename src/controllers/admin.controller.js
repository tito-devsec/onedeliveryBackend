import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute } from "../config/db.js";
import { sendPushNotification, broadcastNotification } from "../services/notification.service.js";
import { notifyExternally } from "../services/messaging.service.js";
import { uploadBuffer } from "../services/upload.service.js";
import { cacheDel } from "../config/redis.js";

// ── Dashboard ─────────────────────────────────────────────────────────────────
export async function getDashboard(req, res) {
  try {
    const [
      orders, customers, products, revenue,
      pendingProducts, pendingSellers, pendingDrivers,
      activeDrivers, todayOrders,
    ] = await Promise.all([
      queryOne("SELECT COUNT(*) AS c FROM orders"),
      queryOne("SELECT COUNT(*) AS c FROM users WHERE role = 'customer'"),
      queryOne("SELECT COUNT(*) AS c FROM products WHERE status = 'approved'"),
      queryOne("SELECT COALESCE(SUM(total_price),0) AS c FROM orders WHERE payment_status = 'success'"),
      queryOne("SELECT COUNT(*) AS c FROM products WHERE status = 'pending'"),
      queryOne("SELECT COUNT(*) AS c FROM seller_applications WHERE status = 'pending'"),
      queryOne("SELECT COUNT(*) AS c FROM driver_applications WHERE status = 'pending'"),
      queryOne("SELECT COUNT(*) AS c FROM driver_profiles WHERE is_online = 1 AND is_approved = 1"),
      queryOne("SELECT COUNT(*) AS c FROM orders WHERE DATE(created_at) = CURDATE()"),
    ]);

    res.json({
      totalOrders:       orders.c,
      totalCustomers:    customers.c,
      totalProducts:     products.c,
      totalRevenue:      parseFloat(revenue.c),
      pendingProducts:   pendingProducts.c,
      pendingSellers:    pendingSellers.c,
      pendingDrivers:    pendingDrivers.c,
      activeDrivers:     activeDrivers.c,
      todayOrders:       todayOrders.c,
    });
  } catch (err) {
    console.error("getDashboard:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Users ─────────────────────────────────────────────────────────────────────
export async function listUsers(req, res) {
  try {
    const { role, page = 1, limit = 30, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = "1=1";
    const vals = [];
    if (role)   { where += " AND role = ?"; vals.push(role); }
    if (search) { where += " AND (name LIKE ? OR email LIKE ?)"; vals.push(`%${search}%`, `%${search}%`); }

    const users = await query(
      `SELECT id, name, email, phone, role, is_active, created_at FROM users WHERE ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...vals, parseInt(limit), offset]
    );
    const [{ total }] = await query(`SELECT COUNT(*) AS total FROM users WHERE ${where}`, vals);
    res.json({ users, total });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function toggleUserActive(req, res) {
  try {
    const { id } = req.params;
    const user = await queryOne("SELECT is_active FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: "User not found" });
    await execute("UPDATE users SET is_active = ? WHERE id = ?", [user.is_active ? 0 : 1, id]);
    res.json({ message: user.is_active ? "User suspended" : "User activated" });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
}

export async function deleteUser(req, res) {
  try {
    const { id } = req.params;
    if (id === req.user.id) return res.status(400).json({ error: "You cannot delete your own admin account" });
    const user = await queryOne("SELECT id, role FROM users WHERE id = ?", [id]);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.role === "admin") return res.status(403).json({ error: "Cannot delete another admin" });
    await execute("DELETE FROM users WHERE id = ?", [id]); // cascades to profiles/applications/tokens
    res.json({ message: "User deleted" });
  } catch (err) {
    console.error("deleteUser:", err.message);
    res.status(500).json({ error: "Delete failed" });
  }
}

// ── Products ─────────────────────────────────────────────────────────────────
export async function listAdminProducts(req, res) {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = "1=1";
    const vals = [];
    if (status) { where += " AND p.status = ?"; vals.push(status); }

    const products = await query(
      `SELECT p.*, c.name AS category_name, u.name AS seller_user_name, sp.shop_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN users u ON p.seller_id = u.id
       LEFT JOIN seller_profiles sp ON p.seller_id = sp.user_id
       WHERE ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [...vals, parseInt(limit), offset]
    );
    const [{ total }] = await query(`SELECT COUNT(*) AS total FROM products p WHERE ${where}`, vals);
    res.json({ products, total });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function approveProduct(req, res) {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body; // status: 'approved' | 'rejected'
    if (!["approved","rejected"].includes(status)) return res.status(400).json({ error: "Invalid status" });

    const product = await queryOne("SELECT * FROM products WHERE id = ?", [id]);
    if (!product) return res.status(404).json({ error: "Product not found" });

    await execute("UPDATE products SET status = ?, rejection_reason = ? WHERE id = ?",
      [status, rejection_reason || "", id]);

    if (product.seller_id) {
      const msg = status === "approved"
        ? { title: "✅ Product Approved!", body: `"${product.name}" is now live in the app.` }
        : { title: "❌ Product Rejected",  body: `"${product.name}" was rejected. Reason: ${rejection_reason || "Not specified"}` };
      sendPushNotification(product.seller_id, { ...msg, type: `product_${status}`, data: { productId: id } }).catch(() => {});
    }

    res.json({ message: `Product ${status}` });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
}

export async function featureProduct(req, res) {
  try {
    const { id } = req.params;
    const { days = 7, feature = true, force = false } = req.body;

    if (feature === false || feature === "false") {
      await execute("UPDATE products SET is_featured = 0, featured_until = NULL WHERE id = ?", [id]);
      await cacheDel(`product:${id}`);
      return res.json({ message: "Product un-featured" });
    }

    const product = await queryOne("SELECT id, name, seller_id FROM products WHERE id = ?", [id]);
    if (!product) return res.status(404).json({ error: "Product not found" });

    // Featured slots are a benefit of PAID seller packages. Products owned by a
    // seller can only be featured while that seller has an active paid
    // subscription — unless the admin explicitly overrides with { force: true }.
    if (product.seller_id && !force) {
      const seller = await queryOne("SELECT role FROM users WHERE id = ?", [product.seller_id]);
      if (seller?.role !== "admin") {
        const paidSub = await queryOne(
          `SELECT s.id FROM subscriptions s
           JOIN packages p ON s.package_id = p.id
           WHERE s.user_id = ? AND s.status = 'active' AND s.expires_at > NOW()
             AND p.type = 'seller' AND p.is_free = 0
           LIMIT 1`,
          [product.seller_id]
        );
        if (!paidSub) {
          return res.status(400).json({
            error: "This seller has no active paid package. Assign a paid seller package first, or send { force: true } to override.",
          });
        }
      }
    }

    const until = new Date(Date.now() + parseInt(days) * 86400 * 1000);
    await execute("UPDATE products SET is_featured = 1, featured_until = ? WHERE id = ?", [until, id]);
    await cacheDel(`product:${id}`);
    res.json({ message: `Product featured for ${days} days` });
  } catch (err) {
    console.error("featureProduct:", err.message);
    res.status(500).json({ error: "Feature failed" });
  }
}

// ── Seller Applications ───────────────────────────────────────────────────────
export async function listSellerApplications(req, res) {
  try {
    const { status = "pending" } = req.query;
    const apps = await query(
      `SELECT sa.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
       FROM seller_applications sa JOIN users u ON sa.user_id = u.id
       WHERE sa.status = ? ORDER BY sa.created_at DESC`,
      [status]
    );
    res.json({ applications: apps });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function reviewSellerApplication(req, res) {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body;
    if (!["approved","rejected"].includes(status)) return res.status(400).json({ error: "Invalid status" });

    const app = await queryOne("SELECT * FROM seller_applications WHERE id = ?", [id]);
    if (!app) return res.status(404).json({ error: "Application not found" });

    await execute(
      "UPDATE seller_applications SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
      [status, rejection_reason || "", req.user.id, id]
    );

    if (status === "approved") {
      // Upgrade user role to seller
      await execute("UPDATE users SET role = 'seller' WHERE id = ?", [app.user_id]);
      // Create seller profile
      const existingProfile = await queryOne("SELECT id FROM seller_profiles WHERE user_id = ?", [app.user_id]);
      if (!existingProfile) {
        await execute(
          `INSERT INTO seller_profiles (id, user_id, shop_name, shop_description, shop_phone, shop_address, shop_lat, shop_lng, is_approved)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [uuidv4(), app.user_id, app.business_name, app.business_description, app.business_phone, app.business_address,
           app.shop_lat ?? null, app.shop_lng ?? null]
        );
      } else {
        await execute(
          "UPDATE seller_profiles SET is_approved = 1, shop_lat = COALESCE(shop_lat, ?), shop_lng = COALESCE(shop_lng, ?) WHERE user_id = ?",
          [app.shop_lat ?? null, app.shop_lng ?? null, app.user_id]
        );
      }
      sendPushNotification(app.user_id, {
        title: "🎉 Seller Application Approved!",
        body:  "You can now add products and start selling on OneDelivery.",
        type:  "seller_approved",
        data:  { screen: "seller_dashboard" },
      }).catch(() => {});
    } else {
      sendPushNotification(app.user_id, {
        title: "❌ Seller Application Rejected",
        body:  rejection_reason || "Your application did not meet our requirements.",
        type:  "seller_rejected",
        data:  {},
      }).catch(() => {});
    }

    res.json({ message: `Application ${status}` });
  } catch (err) {
    console.error("reviewSellerApplication:", err.message);
    res.status(500).json({ error: "Review failed" });
  }
}

// ── Driver Applications ───────────────────────────────────────────────────────
export async function listDriverApplications(req, res) {
  try {
    const { status = "pending" } = req.query;
    const apps = await query(
      `SELECT da.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
       FROM driver_applications da JOIN users u ON da.user_id = u.id
       WHERE da.status = ? ORDER BY da.created_at DESC`,
      [status]
    );
    res.json({ applications: apps });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function reviewDriverApplication(req, res) {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body;
    if (!["approved","rejected"].includes(status)) return res.status(400).json({ error: "Invalid status" });

    const app = await queryOne("SELECT * FROM driver_applications WHERE id = ?", [id]);
    if (!app) return res.status(404).json({ error: "Application not found" });

    await execute(
      "UPDATE driver_applications SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
      [status, rejection_reason || "", req.user.id, id]
    );

    if (status === "approved") {
      await execute("UPDATE users SET role = 'driver' WHERE id = ?", [app.user_id]);
      const existing = await queryOne("SELECT id FROM driver_profiles WHERE user_id = ?", [app.user_id]);
      if (!existing) {
        await execute(
          `INSERT INTO driver_profiles (id, user_id, vehicle_type, plate_number, vehicle_color, vehicle_model,
             license_number, id_document_url, license_document_url, vehicle_photo_url, driver_photo_url,
             mobile_money_number, is_approved)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [uuidv4(), app.user_id, app.vehicle_type, app.plate_number, app.vehicle_color || "",
           app.vehicle_model || "", app.license_number || "", app.id_document_url || "",
           app.license_document_url || "", app.vehicle_photo_url || "", app.driver_photo_url || "",
           app.mobile_money_number || ""]
        );
      } else {
        await execute("UPDATE driver_profiles SET is_approved = 1 WHERE user_id = ?", [app.user_id]);
      }
      sendPushNotification(app.user_id, {
        title: "🚀 Driver Application Approved!",
        body:  "You can now go online and start receiving delivery requests.",
        type:  "driver_approved",
        data:  { screen: "driver_home" },
      }).catch(() => {});

      // Also notify on phone number / email (out-of-app channels)
      const owner = await queryOne("SELECT name, email, phone FROM users WHERE id = ?", [app.user_id]);
      if (owner) {
        notifyExternally({
          email: owner.email,
          phone: owner.phone,
          subject: "Your One Delivery driver application is approved 🚀",
          message: `Hi ${owner.name || "driver"}, great news! Your One Delivery driver application has been approved. Open the One Delivery Driver app and tap GO LIVE to start receiving delivery requests. — From Anywhere To You.`,
        }).catch(() => {});
      }
    } else {
      sendPushNotification(app.user_id, {
        title: "❌ Driver Application Rejected",
        body:  rejection_reason || "Your application was not successful.",
        type:  "driver_rejected",
        data:  {},
      }).catch(() => {});
      const owner = await queryOne("SELECT name, email, phone FROM users WHERE id = ?", [app.user_id]);
      if (owner) {
        notifyExternally({
          email: owner.email,
          phone: owner.phone,
          subject: "Update on your One Delivery driver application",
          message: `Hi ${owner.name || "driver"}, your One Delivery driver application was not approved. ${rejection_reason ? "Reason: " + rejection_reason + ". " : ""}You can update your documents and re-apply in the app.`,
        }).catch(() => {});
      }
    }

    res.json({ message: `Application ${status}` });
  } catch (err) {
    res.status(500).json({ error: "Review failed" });
  }
}

// ── Orders (admin view) ───────────────────────────────────────────────────────
export async function listAdminOrders(req, res) {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = "1=1";
    const vals = [];
    if (status) { where += " AND o.status = ?"; vals.push(status); }

    const orders = await query(
      `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone,
              sp.shop_name AS seller_shop
       FROM orders o
       JOIN users u ON o.user_id = u.id
       LEFT JOIN seller_profiles sp ON o.seller_id = sp.user_id
       WHERE ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
      [...vals, parseInt(limit), offset]
    );
    const [{ total }] = await query(`SELECT COUNT(*) AS total FROM orders o WHERE ${where}`, vals);
    res.json({ orders, total });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Deliveries (admin tracking) ───────────────────────────────────────────────
export async function listAdminDeliveries(req, res) {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = "1=1";
    const vals = [];
    if (status) { where += " AND r.status = ?"; vals.push(status); }

    const rides = await query(
      `SELECT r.*, cu.name AS customer_name, du.name AS driver_name, dp.plate_number
       FROM ride_requests r
       JOIN users cu ON r.customer_id = cu.id
       LEFT JOIN driver_profiles dp ON r.driver_id = dp.id
       LEFT JOIN users du ON dp.user_id = du.id
       WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      [...vals, parseInt(limit), offset]
    );
    const [{ total }] = await query(`SELECT COUNT(*) AS total FROM ride_requests r WHERE ${where}`, vals);
    res.json({ deliveries: rides, total });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Drivers (admin view) ──────────────────────────────────────────────────────
export async function listAdminDrivers(req, res) {
  try {
    const { approved, online } = req.query;
    let where = "1=1";
    const vals = [];
    if (approved !== undefined) { where += " AND dp.is_approved = ?"; vals.push(approved === "true" ? 1 : 0); }
    if (online   !== undefined) { where += " AND dp.is_online = ?";   vals.push(online   === "true" ? 1 : 0); }

    const drivers = await query(
      `SELECT dp.*, u.name, u.email, u.phone
       FROM driver_profiles dp JOIN users u ON dp.user_id = u.id
       WHERE ${where} ORDER BY dp.created_at DESC`,
      vals
    );
    res.json({ drivers });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Reviews (admin moderation) ────────────────────────────────────────────────
export async function listAdminReviews(req, res) {
  try {
    const { hidden = false } = req.query;
    const reviews = await query(
      `SELECT r.*, u.name AS reviewer_name, p.name AS product_name
       FROM reviews r
       JOIN users u ON r.user_id = u.id
       LEFT JOIN products p ON r.product_id = p.id
       WHERE r.is_hidden = ?
       ORDER BY r.created_at DESC LIMIT 100`,
      [hidden ? 1 : 0]
    );
    res.json({ reviews });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function hideReview(req, res) {
  try {
    const { id } = req.params;
    const { admin_note } = req.body;
    await execute("UPDATE reviews SET is_hidden = 1, admin_note = ? WHERE id = ?", [admin_note || "", id]);
    res.json({ message: "Review hidden" });
  } catch (err) {
    res.status(500).json({ error: "Hide failed" });
  }
}

// ── Categories ────────────────────────────────────────────────────────────────
export async function listCategories(req, res) {
  try {
    const cats = await query("SELECT * FROM categories ORDER BY sort_order ASC");
    res.json({ categories: cats });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function createCategory(req, res) {
  try {
    const { name, icon, color, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    let image_url = "";
    if (req.file) {
      const r = await uploadBuffer(req.file.buffer, "categories");
      image_url = r.secure_url;
    }
    const id = uuidv4();
    await execute("INSERT INTO categories (id, name, icon, color, image_url, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      [id, name, icon || "grid-outline", color || "#64748B", image_url, parseInt(sort_order) || 99]);
    await cacheDel("categories:public");
    res.status(201).json({ id, name, image_url });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Category already exists" });
    res.status(500).json({ error: "Create failed" });
  }
}

export async function updateCategory(req, res) {
  try {
    const { id } = req.params;
    const { name, icon, color, sort_order } = req.body;
    const fields = []; const vals = [];
    if (name)       { fields.push("name = ?");       vals.push(name); }
    if (icon)       { fields.push("icon = ?");       vals.push(icon); }
    if (color)      { fields.push("color = ?");      vals.push(color); }
    if (sort_order) { fields.push("sort_order = ?"); vals.push(parseInt(sort_order)); }
    if (req.file) {
      const r = await uploadBuffer(req.file.buffer, "categories");
      fields.push("image_url = ?"); vals.push(r.secure_url);
    }
    if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(id);
    await execute(`UPDATE categories SET ${fields.join(", ")} WHERE id = ?`, vals);
    await cacheDel("categories:public");
    res.json({ message: "Category updated" });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
}

export async function deleteCategory(req, res) {
  try {
    await execute("DELETE FROM categories WHERE id = ?", [req.params.id]);
    await cacheDel("categories:public");
    res.json({ message: "Category deleted" });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
}

// ── Packages (admin manages) ──────────────────────────────────────────────────
export async function listPackages(req, res) {
  try {
    const pkgs = await query("SELECT * FROM packages ORDER BY type, sort_order");
    res.json({ packages: pkgs });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function updatePackage(req, res) {
  try {
    const { id } = req.params;
    const { name, price, duration_days, features, is_active } = req.body;
    const fields = []; const vals = [];
    if (name)         { fields.push("name = ?");          vals.push(name); }
    if (price != null){ fields.push("price = ?");         vals.push(parseFloat(price)); }
    if (duration_days){ fields.push("duration_days = ?"); vals.push(parseInt(duration_days)); }
    if (features)     { fields.push("features = ?");      vals.push(JSON.stringify(features)); }
    if (is_active != null) { fields.push("is_active = ?"); vals.push(is_active ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(id);
    await execute(`UPDATE packages SET ${fields.join(", ")} WHERE id = ?`, vals);
    res.json({ message: "Package updated" });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
}

// ── Withdrawals (admin processes bank withdrawals) ────────────────────────────
export async function listWithdrawals(req, res) {
  try {
    const { status = "pending" } = req.query;
    const rows = await query(
      `SELECT w.*, u.name AS user_name, u.email AS user_email
       FROM withdrawals w JOIN users u ON w.user_id = u.id
       WHERE w.status = ? ORDER BY w.created_at ASC`,
      [status]
    );
    res.json({ withdrawals: rows });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function processWithdrawal(req, res) {
  try {
    const { id } = req.params;
    const { status, failure_reason } = req.body; // 'completed' | 'failed'
    if (!["completed","failed"].includes(status)) return res.status(400).json({ error: "Invalid status" });

    const wd = await queryOne("SELECT * FROM withdrawals WHERE id = ?", [id]);
    if (!wd) return res.status(404).json({ error: "Withdrawal not found" });
    if (wd.status !== "pending" && wd.status !== "processing") {
      return res.status(400).json({ error: "Already processed" });
    }

    if (status === "failed") {
      // Refund balance
      const table = wd.user_role === "seller" ? "seller_profiles" : "driver_profiles";
      await execute(`UPDATE ${table} SET balance = balance + ? WHERE user_id = ?`, [wd.amount, wd.user_id]);
      await execute("UPDATE withdrawals SET status = 'failed', failure_reason = ?, processed_at = NOW() WHERE id = ?",
        [failure_reason || "Admin rejected", id]);
      sendPushNotification(wd.user_id, {
        title: "❌ Withdrawal Failed",
        body:  failure_reason || "Your withdrawal could not be processed.",
        type:  "withdrawal_failed", data: {},
        app:   wd.user_role === "seller" ? "shop" : "driver",
      }).catch(() => {});
    } else {
      await execute("UPDATE withdrawals SET status = 'completed', processed_at = NOW() WHERE id = ?", [id]);
      sendPushNotification(wd.user_id, {
        title: "✅ Withdrawal Processed!",
        body:  `TZS ${parseFloat(wd.amount).toLocaleString()} has been sent to your account.`,
        type:  "withdrawal_completed", data: {},
        app:   wd.user_role === "seller" ? "shop" : "driver",
      }).catch(() => {});
    }

    res.json({ message: `Withdrawal ${status}` });
  } catch (err) {
    res.status(500).json({ error: "Process failed" });
  }
}

// ── Broadcast Notification ────────────────────────────────────────────────────
export async function sendBroadcast(req, res) {
  try {
    const { title, body, role, type = "broadcast" } = req.body;
    if (!title || !body) return res.status(400).json({ error: "title and body required" });

    let userIds;
    if (role) {
      const users = await query("SELECT id FROM users WHERE role = ? AND is_active = 1", [role]);
      userIds = users.map((u) => u.id);
    } else {
      const users = await query("SELECT id FROM users WHERE is_active = 1");
      userIds = users.map((u) => u.id);
    }

    const app = role === "driver" ? "driver" : role ? "shop" : null;
    await broadcastNotification(userIds, { title, body, type, data: {}, app });
    res.json({ message: `Broadcast sent to ${userIds.length} users` });
  } catch (err) {
    res.status(500).json({ error: "Broadcast failed" });
  }
}

// ── Seller Management ─────────────────────────────────────────────────────────
export async function listSellers(req, res) {
  try {
    const sellers = await query(
      `SELECT sp.*, u.name, u.email, u.phone, u.is_active,
              (SELECT COUNT(*) FROM products WHERE seller_id = u.id AND status='approved') AS product_count,
              (SELECT COUNT(*) FROM orders WHERE seller_id = u.id AND payment_status='success') AS order_count
       FROM seller_profiles sp JOIN users u ON sp.user_id = u.id
       ORDER BY sp.created_at DESC`
    );
    res.json({ sellers });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Assign Package to User (admin override) ───────────────────────────────────
export async function assignPackage(req, res) {
  try {
    const { userId, packageId, durationDays } = req.body;
    const pkg = await queryOne("SELECT * FROM packages WHERE id = ?", [packageId]);
    if (!pkg) return res.status(404).json({ error: "Package not found" });

    const expires = new Date(Date.now() + (durationDays || pkg.duration_days) * 86400 * 1000);
    await execute(
      "INSERT INTO subscriptions (id, user_id, package_id, amount, status, activated_at, expires_at) VALUES (?, ?, ?, 0, 'active', NOW(), ?)",
      [uuidv4(), userId, packageId, expires]
    );
    sendPushNotification(userId, {
      title: "🎁 Package Assigned!",
      body:  `Admin has assigned you the ${pkg.name} package.`,
      type:  "package_assigned", data: { packageId },
    }).catch(() => {});
    res.json({ message: "Package assigned" });
  } catch (err) {
    res.status(500).json({ error: "Assign failed" });
  }
}
