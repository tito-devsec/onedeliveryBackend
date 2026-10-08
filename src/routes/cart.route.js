// src/routes/cart.route.js
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { getCart, addToCart, updateCartItem, removeFromCart, clearCart } from "../controllers/cart.controller.js";

const router = Router();
router.use(authenticate);

router.get   ("/",    getCart);
router.post  ("/",    addToCart);
router.put   ("/:id", updateCartItem);
router.delete("/:id", removeFromCart);
router.delete("/",    clearCart);

export default router;
