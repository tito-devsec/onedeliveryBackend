import { Router } from "express";
import { authenticate, requireDriver } from "../middleware/auth.middleware.js";
import {
  getVehicleOptions, requestRide, getRideStatus, rideRoute, getRideByOrder,
  rideHistory, cancelRide, availableRides, acceptRide, declineRide, updateRideStatus,
  updateDriverLocation, toggleOnline, driverCurrentRide, driverHistory,
  driverEarnings, rateDriver,
} from "../controllers/ride.controller.js";

const router = Router();

// Customer
router.get   ("/options",               authenticate, getVehicleOptions);
router.post  ("/request",               authenticate, requestRide);
router.get   ("/history",               authenticate, rideHistory);
router.get   ("/order/:orderId",        authenticate, getRideByOrder);
router.get   ("/:rideId",               authenticate, getRideStatus);
router.get   ("/:rideId/route",         authenticate, rideRoute);       // customer, seller or driver
router.delete("/:rideId/cancel",        authenticate, cancelRide);
router.post  ("/:rideId/rate",          authenticate, rateDriver);

// Driver
router.get   ("/driver/available",      authenticate, requireDriver, availableRides);
router.get   ("/driver/current",        authenticate, requireDriver, driverCurrentRide);
router.get   ("/driver/history",        authenticate, requireDriver, driverHistory);
router.get   ("/driver/earnings",       authenticate, requireDriver, driverEarnings);
router.post  ("/:rideId/accept",        authenticate, requireDriver, acceptRide);
router.post  ("/:rideId/decline",       authenticate, requireDriver, declineRide);
router.put   ("/:rideId/status",        authenticate, requireDriver, updateRideStatus);
router.put   ("/driver/location",       authenticate, requireDriver, updateDriverLocation);
router.put   ("/driver/online",         authenticate, requireDriver, toggleOnline);

export default router;
