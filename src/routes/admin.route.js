import { Router } from "express";
import { authenticate, requireAdmin } from "../middleware/auth.middleware.js";
import { uploadImage } from "../middleware/upload.middleware.js";
import {
  getDashboard, listUsers, toggleUserActive, deleteUser,
  listAdminProducts, approveProduct, featureProduct,
  listSellerApplications, reviewSellerApplication,
  listDriverApplications, reviewDriverApplication,
  listAdminOrders, listAdminDeliveries, listAdminDrivers,
  listAdminReviews, hideReview,
  listCategories, createCategory, updateCategory, deleteCategory,
  listPackages, updatePackage,
  listWithdrawals, processWithdrawal,
  sendBroadcast, listSellers, assignPackage,
} from "../controllers/admin.controller.js";

const router = Router();
router.use(authenticate, requireAdmin);

// Dashboard
router.get("/dashboard", getDashboard);

// Users
router.get ("/users",              listUsers);
router.put ("/users/:id/toggle",   toggleUserActive);
router.delete("/users/:id",        deleteUser);

// Products
router.get ("/products",              listAdminProducts);
router.put ("/products/:id/approve",  approveProduct);
router.put ("/products/:id/feature",  featureProduct);

// Seller applications
router.get("/seller-applications",            listSellerApplications);
router.put("/seller-applications/:id/review", reviewSellerApplication);
router.get("/sellers",                         listSellers);

// Driver applications
router.get("/driver-applications",            listDriverApplications);
router.put("/driver-applications/:id/review", reviewDriverApplication);
router.get("/drivers",                         listAdminDrivers);

// Orders & deliveries
router.get("/orders",     listAdminOrders);
router.get("/deliveries", listAdminDeliveries);

// Reviews
router.get("/reviews",          listAdminReviews);
router.put("/reviews/:id/hide", hideReview);

// Categories
router.get   ("/categories",     listCategories);
router.post  ("/categories",     uploadImage.single("image"), createCategory);
router.put   ("/categories/:id", uploadImage.single("image"), updateCategory);
router.delete("/categories/:id", deleteCategory);

// Packages
router.get("/packages",      listPackages);
router.put("/packages/:id",  updatePackage);
router.post("/packages/assign", assignPackage);

// Withdrawals
router.get("/withdrawals",             listWithdrawals);
router.put("/withdrawals/:id/process", processWithdrawal);

// Broadcast
router.post("/broadcast", sendBroadcast);

export default router;
