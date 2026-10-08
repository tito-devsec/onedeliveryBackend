import { Router } from "express";
import { authenticate, requireSeller, requireAdmin } from "../middleware/auth.middleware.js";
import { uploadImages } from "../middleware/upload.middleware.js";
import { listProducts, getProduct, createProduct, updateProduct, deleteProduct, myProducts, listPublicCategories } from "../controllers/product.controller.js";

const router = Router();

router.get("/",              listProducts);
router.get("/categories",    listPublicCategories);   // PUBLIC — customer app home
router.get("/seller/mine",   authenticate, requireSeller, myProducts);
router.get("/:id",           getProduct);
router.post("/",             authenticate, requireSeller, uploadImages.array("images", 6), createProduct);
router.put("/:id",           authenticate, requireSeller, uploadImages.array("images", 6), updateProduct);
router.delete("/:id",        authenticate, requireSeller, deleteProduct);

export default router;
