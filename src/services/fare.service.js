// Delivery fares, worked out the way Bolt prices trips in Dar es Salaam:
//   fare = base + per-km × road distance + per-minute × driving time,
// never below the minimum, rounded to TZS 100. Rates are calibrated on Bolt's own
// Dar es Salaam estimates (Oct 2026): Boda ≈ 460 + 420/km, Bolt car ≈ 500 + 810/km,
// XL ≈ 4,040 + 1,080/km at city speed (~2.2 min/km). The per-minute part makes heavy
// traffic count, as it does on Bolt.
// The result is the SUGGESTED price: customers may offer within OFFER_LIMITS and drivers
// may counter (see ride.controller).

// Part of the delivery fee paid out to the driver (15% platform commission)
export const DRIVER_SHARE = 0.85;

// TZS
export const TARIFFS = {
  bodaboda: { base: 500,  perKm: 330, perMin: 40,  min: 1500 }, // ≈ Bolt Boda
  bajaj:    { base: 700,  perKm: 480, perMin: 55,  min: 2000 }, // between Boda and a car
  toyo:     { base: 600,  perKm: 640, perMin: 75,  min: 4000 }, // ≈ Bolt (car)
  pickup:   { base: 4000, perKm: 860, perMin: 100, min: 8000 }, // ≈ Bolt XL
};

// Customer offers may go from 80% to 300% of the suggested price; driver counters up to 300%
export const OFFER_LIMITS = { minRatio: 0.8, maxRatio: 3 };

const ROAD_FACTOR = 1.3; // straight line → road distance when no route is available
const CITY_KMH    = 27;  // Bolt's Dar estimates assume ~2.2 min per km

export const roundFare = (n) => Math.round(n / 100) * 100;

export function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Road km and driving minutes: from the Google route when there is one, otherwise
// estimated from the straight-line distance
export function tripMetrics(straightKm, route) {
  if (route?.distanceMeters) {
    return { km: route.distanceMeters / 1000, min: Math.max(1, (route.durationSeconds || 0) / 60), estimated: false };
  }
  const km = straightKm * ROAD_FACTOR;
  return { km, min: (km / CITY_KMH) * 60, estimated: true };
}

export function calcFare(vehicleType, km, min) {
  const t = TARIFFS[vehicleType] || TARIFFS.bodaboda;
  const minutes = min ?? (km / CITY_KMH) * 60;
  return Math.max(t.min, roundFare(t.base + t.perKm * km + t.perMin * minutes));
}

// What a customer may offer for a suggested price
export function offerRange(suggested, vehicleType) {
  const t = TARIFFS[vehicleType] || TARIFFS.bodaboda;
  return {
    min: Math.max(t.min, roundFare(suggested * OFFER_LIMITS.minRatio)),
    max: roundFare(suggested * OFFER_LIMITS.maxRatio),
  };
}

export const VEHICLE_INFO = {
  bodaboda: { id: "bodaboda", name: "Bodaboda",       subtitle: "Motorcycle, fast",       icon: "🏍️", capacity: "Small packages", eta: "3–7 min",   color: "#F97316" },
  bajaj:    { id: "bajaj",    name: "Bajaj",          subtitle: "3-wheel, affordable",    icon: "🛺", capacity: "Small packages", eta: "5–10 min",  color: "#F59E0B" },
  pickup:   { id: "pickup",   name: "Pickup / Carry", subtitle: "Large & heavy items",    icon: "🚛", capacity: "Large packages", eta: "10–20 min", color: "#1D4ED8" },
  toyo:     { id: "toyo",     name: "Toyo",           subtitle: "Toyota Hilux / similar", icon: "🚙", capacity: "Medium-large",   eta: "8–15 min",  color: "#059669" },
};
