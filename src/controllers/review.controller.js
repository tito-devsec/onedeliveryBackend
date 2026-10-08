import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute } from "../config/db.js";

// GET /api/reviews/product/:productId
export async function productReviews(req, res) {
  try {
    const reviews = await query(
      `SELECT r.id, r.rating, r.comment, r.created_at, u.name AS reviewer_name, u.profile_image AS reviewer_image
       FROM reviews r JOIN users u ON r.user_id = u.id
       WHERE r.product_id = ? AND r.is_hidden = 0
       ORDER BY r.created_at DESC LIMIT 50`,
      [req.params.productId]
    );
    const [avg] = await query(
      "SELECT AVG(rating) AS avg, COUNT(*) AS total FROM reviews WHERE product_id = ? AND is_hidden = 0",
      [req.params.productId]
    );
    res.json({ reviews, avgRating: parseFloat(avg.avg || 0).toFixed(1), total: avg.total });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/reviews/product/:productId
export async function addProductReview(req, res) {
  try {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating 1-5 required" });

    // Verify user purchased the product
    const bought = await queryOne(
      `SELECT oi.id FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE oi.product_id = ? AND o.user_id = ? AND o.payment_status = 'success'
       LIMIT 1`,
      [req.params.productId, req.user.id]
    );
    if (!bought) return res.status(403).json({ error: "You must purchase this product before reviewing" });

    const existing = await queryOne("SELECT id FROM reviews WHERE product_id = ? AND user_id = ?",
      [req.params.productId, req.user.id]);
    if (existing) return res.status(400).json({ error: "You already reviewed this product" });

    await execute(
      "INSERT INTO reviews (id, user_id, product_id, rating, comment) VALUES (?, ?, ?, ?, ?)",
      [uuidv4(), req.user.id, req.params.productId, parseInt(rating), comment || ""]
    );

    // Update product avg rating
    const [stats] = await query(
      "SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM reviews WHERE product_id = ? AND is_hidden = 0",
      [req.params.productId]
    );
    await execute("UPDATE products SET avg_rating = ?, total_reviews = ? WHERE id = ?",
      [parseFloat(stats.avg || 0).toFixed(2), stats.cnt, req.params.productId]);

    res.status(201).json({ message: "Review added" });
  } catch (err) {
    res.status(500).json({ error: "Review failed" });
  }
}

// GET /api/reviews/driver/:driverId
export async function driverReviews(req, res) {
  try {
    const reviews = await query(
      `SELECT r.id, r.rating, r.comment, r.created_at, u.name AS reviewer_name
       FROM reviews r JOIN users u ON r.user_id = u.id
       WHERE r.driver_id = ? AND r.is_hidden = 0
       ORDER BY r.created_at DESC LIMIT 50`,
      [req.params.driverId]
    );
    res.json({ reviews });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}
