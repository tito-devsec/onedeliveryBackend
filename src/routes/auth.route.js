// src/routes/auth.route.js
import { Router } from "express";
import { register, login, googleAuth, refresh, logout, getMe, updateMe, changePassword } from "../controllers/auth.controller.js";
import { sendVerification, verifyCode } from "../controllers/verification.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { uploadImage } from "../middleware/upload.middleware.js";
import rateLimit from "express-rate-limit";

const router = Router();
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: "Too many auth requests" } });

router.post("/register", authLimit, register);
router.post("/login",    authLimit, login);
router.post("/google",   authLimit, googleAuth);
router.post("/refresh",  refresh);
router.post("/logout",   logout);
router.get ("/me",       authenticate, getMe);
router.put ("/me",       authenticate, uploadImage.single("avatar"), updateMe);
router.put ("/me/password", authenticate, changePassword);

// Email / SMS verification (Brevo) — optional, does not gate login
router.post("/send-verification", authenticate, authLimit, sendVerification);
router.post("/verify-code",       authenticate, verifyCode);

export default router;
