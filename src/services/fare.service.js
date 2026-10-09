// Part of the delivery fee paid out to the driver
export const DRIVER_SHARE = 0.85;

// TZS pricing for each vehicle type
const BASE  = { bodaboda: 2000, bajaj: 1500, pickup: 5000, toyo: 3500 };
const PER_KM = { bodaboda: 700,  bajaj: 500,  pickup: 1500, toyo: 900 };
const MIN    = { bodaboda: 2500, bajaj: 2000, pickup: 7000, toyo: 4000 };

export function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function calcFare(vehicleType, distanceKm) {
  const base = BASE[vehicleType]  ?? BASE.bodaboda;
  const pkm  = PER_KM[vehicleType] ?? PER_KM.bodaboda;
  const min  = MIN[vehicleType]   ?? MIN.bodaboda;
  return Math.max(Math.round((base + pkm * distanceKm) / 100) * 100, min);
}

export const VEHICLE_INFO = {
  bodaboda: { id: "bodaboda", name: "Bodaboda",     subtitle: "Motorcycle, fast",       icon: "🏍️", capacity: "Small packages",  eta: "3–7 min",   color: "#F97316" },
  bajaj:    { id: "bajaj",    name: "Bajaj",         subtitle: "3-wheel, affordable",    icon: "🛺", capacity: "Small packages",  eta: "5–10 min",  color: "#F59E0B" },
  pickup:   { id: "pickup",   name: "Pickup / Carry",subtitle: "Large & heavy items",    icon: "🚛", capacity: "Large packages",  eta: "10–20 min", color: "#1D4ED8" },
  toyo:     { id: "toyo",     name: "Toyo",          subtitle: "Toyota Hilux / similar", icon: "🚙", capacity: "Medium-large",    eta: "8–15 min",  color: "#059669" },
};
