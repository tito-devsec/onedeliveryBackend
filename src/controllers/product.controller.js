import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute, withTransaction } from "../config/db.js";
import { uploadMultiple } from "../services/upload.service.js";
import { cacheGet, cacheSet, cacheDel } from "../config/redis.js";

// GET /api/products
export async function listProducts(req, res) {
  try {
    const { category, search, page = 1, limit = 20, featured } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where  = "p.status = 'approved'";
    const vals = [];

    if (category) { where += " AND p.category_id = ?"; vals.push(category); }
    if (search)   { where += " AND MATCH(p.name, p.description) AGAINST(? IN BOOLEAN MODE)"; vals.push(`${search}*`); }
    if (featured) { where += " AND p.is_featured = 1 AND (p.featured_until IS NULL OR p.featured_until > NOW())"; }

    const products = await query(
      `SELECT p.id, p.name, p.description, p.price, p.stock, p.images, p.avg_rating, p.total_reviews,
              p.is_featured, p.seller_name, c.name AS category_name, c.id AS category_id
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE ${where}
       ORDER BY p.is_featured DESC, p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...vals, parseInt(limit), offset]
    );

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM products p WHERE ${where}`, vals
    );

    res.json({ products, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error("listProducts:", err.message);
    res.status(500).json({ error: "Failed to fetch products" });
  }
}

// GET /api/products/:id
export async function getProduct(req, res) {
  try {
    const cached = await cacheGet(`product:${req.params.id}`);
    if (cached) return res.json({ product: cached });

    const product = await queryOne(
      `SELECT p.*, c.name AS category_name, u.id AS seller_user_id, sp.shop_name, sp.shop_address, sp.shop_lat, sp.shop_lng
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN seller_profiles sp ON p.seller_id = sp.user_id
       LEFT JOIN users u ON p.seller_id = u.id
       WHERE p.id = ? AND p.status = 'approved'`,
      [req.params.id]
    );
    if (!product) return res.status(404).json({ error: "Product not found" });

    await cacheSet(`product:${req.params.id}`, product, 300);
    res.json({ product });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/products  (seller OR admin)
//  • Sellers create products in `pending` status (admin must approve).
//  • Admins create products that go LIVE immediately (`approved`) and are
//    listed under the "OneDelivery" storefront unless a shop name exists.
export async function createProduct(req, res) {
  try {
    const { name, description, price, stock, category_id } = req.body;
    if (!name || !price) return res.status(400).json({ error: "name and price required" });

    const isAdmin = req.user.role === "admin";

    // Sellers must have an approved profile. Admins bypass this entirely.
    let sellerName = req.user.name;
    if (!isAdmin) {
      const sp = await queryOne(
        "SELECT id, is_approved, shop_name FROM seller_profiles WHERE user_id = ?",
        [req.user.id]
      );
      if (!sp?.is_approved) return res.status(403).json({ error: "Seller account not yet approved" });
      sellerName = sp.shop_name || req.user.name;
    } else {
      sellerName = "OneDelivery";
    }

    let images = [];
    if (req.files?.length) {
      try {
        const results = await uploadMultiple(req.files, "products");
        images = results.map((r) => r.secure_url);
      } catch (upErr) {
        console.error("createProduct image upload:", upErr.message);
        return res.status(502).json({
          error: "Image upload failed. Check Cloudinary configuration (CLOUDINARY_* env vars) and try again.",
        });
      }
    }

    const id     = uuidv4();
    const status = isAdmin ? "approved" : "pending";

    await execute(
      "INSERT INTO products (id, seller_id, seller_name, category_id, name, description, price, stock, images, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, req.user.id, sellerName, category_id || null, name, description || "", parseFloat(price), parseInt(stock) || 0, JSON.stringify(images), status]
    );

    res.status(201).json({
      message:   isAdmin ? "Product published and live" : "Product submitted for review",
      productId: id,
      status,
    });
  } catch (err) {
    console.error("createProduct:", err.message);
    res.status(500).json({ error: "Failed to create product" });
  }
}

// GET /api/products/categories  (PUBLIC — used by the customer app home screen)
export async function listPublicCategories(_req, res) {
  try {
    const cached = await cacheGet("categories:public");
    if (cached) return res.json({ categories: cached });

    const categories = await query(
      "SELECT id, name, icon, color, image_url, sort_order FROM categories ORDER BY sort_order ASC, name ASC"
    );
    await cacheSet("categories:public", categories, 300);
    res.json({ categories });
  } catch (err) {
    console.error("listPublicCategories:", err.message);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
}

// PUT /api/products/:id  (seller or admin)
export async function updateProduct(req, res) {
  try {
    const { name, description, price, stock, category_id } = req.body;
    const product = await queryOne("SELECT * FROM products WHERE id = ?", [req.params.id]);
    if (!product) return res.status(404).json({ error: "Product not found" });
    if (req.user.role !== "admin" && product.seller_id !== req.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }

    const fields = [];
    const vals   = [];
    if (name)        { fields.push("name = ?");        vals.push(name); }
    if (description) { fields.push("description = ?"); vals.push(description); }
    if (price)       { fields.push("price = ?");       vals.push(parseFloat(price)); }
    if (stock != null) { fields.push("stock = ?");     vals.push(parseInt(stock)); }
    if (category_id) { fields.push("category_id = ?"); vals.push(category_id); }

    // Replace images when new files are uploaded with the edit
    if (req.files?.length) {
      const results = await uploadMultiple(req.files, "products");
      fields.push("images = ?");
      vals.push(JSON.stringify(results.map((r) => r.secure_url)));
    }

    if (req.user.role !== "admin") {
      fields.push("status = 'pending'"); // re-review on edit
    }

    if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(req.params.id);
    await execute(`UPDATE products SET ${fields.join(", ")} WHERE id = ?`, vals);
    await cacheDel(`product:${req.params.id}`);

    res.json({ message: "Product updated" });
  } catch (err) {
    console.error("updateProduct:", err.message);
    res.status(500).json({ error: err.http_code ? `Image upload failed: ${err.message}` : "Update failed" });
  }
}

// DELETE /api/products/:id  (seller or admin)
export async function deleteProduct(req, res) {
  try {
    const product = await queryOne("SELECT seller_id FROM products WHERE id = ?", [req.params.id]);
    if (!product) return res.status(404).json({ error: "Product not found" });
    if (req.user.role !== "admin" && product.seller_id !== req.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }
    await execute("DELETE FROM products WHERE id = ?", [req.params.id]);
    await cacheDel(`product:${req.params.id}`);
    res.json({ message: "Product deleted" });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
}

// GET /api/products/seller/mine  (seller's own products)
export async function myProducts(req, res) {
  try {
    const products = await query(
      "SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.seller_id = ? ORDER BY p.created_at DESC",
      [req.user.id]
    );
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}
