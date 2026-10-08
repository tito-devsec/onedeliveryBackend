import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute } from "../config/db.js";

// ── Wishlist ─────────────────────────────────────────────────────────────────
export async function getWishlist(req, res) {
  try {
    const items = await query(
      `SELECT p.id, p.name, p.price, p.images, p.avg_rating, p.total_reviews, p.stock, p.status
       FROM wishlist w JOIN products p ON w.product_id = p.id
       WHERE w.user_id = ? AND p.status = 'approved'
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );
    res.json({ wishlist: items });
  } catch (err) { res.status(500).json({ error: "Internal server error" }); }
}

export async function addToWishlist(req, res) {
  try {
    const { productId } = req.params;
    const existing = await queryOne("SELECT 1 FROM wishlist WHERE user_id = ? AND product_id = ?", [req.user.id, productId]);
    if (!existing) {
      await execute("INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)", [req.user.id, productId]);
    }
    res.json({ added: true });
  } catch (err) { res.status(500).json({ error: "Internal server error" }); }
}

export async function removeFromWishlist(req, res) {
  try {
    await execute("DELETE FROM wishlist WHERE user_id = ? AND product_id = ?", [req.user.id, req.params.productId]);
    res.json({ removed: true });
  } catch (err) { res.status(500).json({ error: "Internal server error" }); }
}

// ── Addresses ─────────────────────────────────────────────────────────────────
export async function getAddresses(req, res) {
  try {
    const addrs = await query("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC", [req.user.id]);
    res.json({ addresses: addrs });
  } catch (err) { res.status(500).json({ error: "Internal server error" }); }
}

export async function addAddress(req, res) {
  try {
    const { label, full_name, street_address, city, region, phone_number, lat, lng, is_default } = req.body;
    if (!street_address || !city) return res.status(400).json({ error: "street_address and city required" });
    const id = uuidv4();
    if (is_default) {
      await execute("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [req.user.id]);
    }
    await execute(
      "INSERT INTO addresses (id, user_id, label, full_name, street_address, city, region, phone_number, lat, lng, is_default) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [id, req.user.id, label || "Home", full_name || "", street_address, city, region || "", phone_number || "", lat || null, lng || null, is_default ? 1 : 0]
    );
    res.status(201).json({ id, message: "Address added" });
  } catch (err) { res.status(500).json({ error: "Internal server error" }); }
}

export async function updateAddress(req, res) {
  try {
    const addr = await queryOne("SELECT id FROM addresses WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (!addr) return res.status(404).json({ error: "Address not found" });
    const { label, full_name, street_address, city, region, phone_number, lat, lng, is_default } = req.body;
    if (is_default) {
      await execute("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [req.user.id]);
    }
    const fields = []; const vals = [];
    const map = { label, full_name, street_address, city, region, phone_number, lat, lng };
    for (const [k, v] of Object.entries(map)) { if (v !== undefined) { fields.push(`${k} = ?`); vals.push(v); } }
    if (is_default !== undefined) { fields.push("is_default = ?"); vals.push(is_default ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(req.params.id);
    await execute(`UPDATE addresses SET ${fields.join(", ")} WHERE id = ?`, vals);
    res.json({ message: "Address updated" });
  } catch (err) { res.status(500).json({ error: "Internal server error" }); }
}

export async function deleteAddress(req, res) {
  try {
    await execute("DELETE FROM addresses WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    res.json({ message: "Address deleted" });
  } catch (err) { res.status(500).json({ error: "Internal server error" }); }
}
