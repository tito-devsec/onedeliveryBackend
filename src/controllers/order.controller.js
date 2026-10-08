import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute, withTransaction } from "../config/db.js";
import { sendPushNotification } from "../services/notification.service.js";
import { ENV } from "../config/env.js";

// GET /api/orders  (user's own orders)
export async function myOrders(req, res) {
  try {
    const orders = await query(
      `SELECT o.*, GROUP_CONCAT(
        JSON_OBJECT('name', oi.name, 'price', oi.price, 'quantity', oi.quantity, 'image', oi.image)
      ) AS items_json
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.user_id = ?
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    const formatted = orders.map((o) => ({
      ...o,
      items: (() => { try { return JSON.parse(`[${o.items_json}]`); } catch { return []; } })(),
      items_json: undefined,
    }));
    res.json({ orders: formatted });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
}

// GET /api/orders/:id
export async function getOrder(req, res) {
  try {
    const order = await queryOne(
      `SELECT o.*, sp.shop_name, sp.shop_address, sp.shop_lat, sp.shop_lng
       FROM orders o
       LEFT JOIN seller_profiles sp ON o.seller_id = sp.user_id
       WHERE o.id = ? AND o.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!order) return res.status(404).json({ error: "Order not found" });
    const items = await query("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
    res.json({ order: { ...order, items } });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/orders/seller/mine  (seller view orders for their products)
export async function sellerOrders(req, res) {
  try {
    const orders = await query(
      `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone
       FROM orders o JOIN users u ON o.user_id = u.id
       WHERE o.seller_id = ? AND o.payment_status = 'success'
       ORDER BY o.created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
}

// PUT /api/orders/:id/status  (seller or admin updates order status)
export async function updateOrderStatus(req, res) {
  try {
    const { status } = req.body;
    const allowed = ["pending","processing","shipped","delivered","cancelled"];
    if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });

    const order = await queryOne("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (req.user.role !== "admin" && order.seller_id !== req.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }

    const timestamps = {
      shipped:   "shipped_at",
      delivered: "delivered_at",
      cancelled: "cancelled_at",
    };
    const tsField = timestamps[status];
    const setSql  = tsField ? `status = ?, ${tsField} = NOW()` : "status = ?";
    const params  = tsField ? [status, order.id] : [status, order.id];
    await execute(`UPDATE orders SET ${setSql} WHERE id = ?`, params);

    // Notify customer
    const msgs = {
      processing: { title: "📦 Order Processing", body: "Your order is being prepared." },
      shipped:    { title: "🚚 Order Shipped",    body: "Your order is on the way!" },
      delivered:  { title: "✅ Order Delivered",  body: "Your order has been delivered. Enjoy!" },
      cancelled:  { title: "❌ Order Cancelled",  body: "Your order was cancelled." },
    };
    if (msgs[status]) {
      sendPushNotification(order.user_id, { ...msgs[status], type: `order_${status}`, data: { orderId: order.id } }).catch(() => {});
    }

    res.json({ message: `Order updated to ${status}` });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
}
