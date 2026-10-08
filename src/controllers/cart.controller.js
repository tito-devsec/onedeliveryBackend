import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute } from "../config/db.js";

// GET /api/cart
export async function getCart(req, res) {
  try {
    const items = await query(
      `SELECT ci.id, ci.quantity, p.id AS product_id, p.name, p.price, p.stock,
              p.images, p.seller_name, p.status
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.user_id = ? AND p.status = 'approved'`,
      [req.user.id]
    );
    const total = items.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
    res.json({ items, total, count: items.length });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/cart
export async function addToCart(req, res) {
  try {
    const { product_id, quantity = 1 } = req.body;
    if (!product_id) return res.status(400).json({ error: "product_id required" });

    const product = await queryOne("SELECT id, stock, status FROM products WHERE id = ?", [product_id]);
    if (!product || product.status !== "approved") return res.status(404).json({ error: "Product not found" });

    const existing = await queryOne("SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ?", [req.user.id, product_id]);
    const newQty = (existing?.quantity || 0) + parseInt(quantity);
    if (newQty > product.stock) return res.status(400).json({ error: "Not enough stock" });

    if (existing) {
      await execute("UPDATE cart_items SET quantity = ? WHERE id = ?", [newQty, existing.id]);
    } else {
      await execute("INSERT INTO cart_items (id, user_id, product_id, quantity) VALUES (?, ?, ?, ?)",
        [uuidv4(), req.user.id, product_id, parseInt(quantity)]);
    }

    res.json({ message: "Added to cart", quantity: newQty });
  } catch (err) {
    res.status(500).json({ error: "Add to cart failed" });
  }
}

// PUT /api/cart/:id
export async function updateCartItem(req, res) {
  try {
    const { quantity } = req.body;
    if (!quantity || quantity < 1) return res.status(400).json({ error: "Valid quantity required" });

    const item = await queryOne("SELECT ci.*, p.stock FROM cart_items ci JOIN products p ON ci.product_id = p.id WHERE ci.id = ? AND ci.user_id = ?", [req.params.id, req.user.id]);
    if (!item) return res.status(404).json({ error: "Cart item not found" });
    if (quantity > item.stock) return res.status(400).json({ error: "Not enough stock" });

    await execute("UPDATE cart_items SET quantity = ? WHERE id = ?", [parseInt(quantity), req.params.id]);
    res.json({ message: "Cart updated" });
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
}

// DELETE /api/cart/:id
export async function removeFromCart(req, res) {
  try {
    await execute("DELETE FROM cart_items WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    res.json({ message: "Removed from cart" });
  } catch (err) {
    res.status(500).json({ error: "Remove failed" });
  }
}

// DELETE /api/cart
export async function clearCart(req, res) {
  try {
    await execute("DELETE FROM cart_items WHERE user_id = ?", [req.user.id]);
    res.json({ message: "Cart cleared" });
  } catch (err) {
    res.status(500).json({ error: "Clear failed" });
  }
}
