import { Router } from "express";
import { authenticate, requireSeller } from "../middleware/auth.middleware.js";
import { myOrders, getOrder, sellerOrders, updateOrderStatus } from "../controllers/order.controller.js";

const router = Router();

router.get("/",              authenticate, myOrders);
router.get("/seller/mine",   authenticate, requireSeller, sellerOrders);
router.get("/:id",           authenticate, getOrder);
router.put("/:id/status",    authenticate, requireSeller, updateOrderStatus);

export default router;
