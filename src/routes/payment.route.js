import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import rateLimit from "express-rate-limit";
import {
  getProviders, checkout, checkoutCard, payDeliveryFee,
  paymentStatus, purchasePackage, requestWithdrawal,
  myWithdrawals, snippeWebhook,
} from "../controllers/payment.controller.js";

const router = Router();
const payLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: "Too many payment requests" } });

// Webhook must receive raw body (set in server.js)
router.post("/webhook", snippeWebhook);

router.get ("/providers",         getProviders);
router.post("/checkout",          authenticate, payLimit, checkout);
router.post("/checkout/card",     authenticate, payLimit, checkoutCard);
router.post("/delivery",          authenticate, payLimit, payDeliveryFee);
router.get ("/status/:orderId",   authenticate, paymentStatus);
router.post("/package",           authenticate, payLimit, purchasePackage);
router.post("/withdraw",          authenticate, requestWithdrawal);
router.get ("/withdrawals/my",    authenticate, myWithdrawals);

export default router;
