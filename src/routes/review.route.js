// src/routes/review.route.js
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { productReviews, addProductReview, driverReviews } from "../controllers/review.controller.js";

const router = Router();

router.get ("/product/:productId",       productReviews);
router.post("/product/:productId",       authenticate, addProductReview);
router.get ("/driver/:driverId",         driverReviews);

export default router;
