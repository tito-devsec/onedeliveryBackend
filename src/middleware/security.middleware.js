import crypto from "crypto";

export function requestId(req, _res, next) {
  req.requestId = crypto.randomBytes(8).toString("hex");
  next();
}

// Sanitize common XSS vectors from body/query/params
function sanitize(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === "string") {
      obj[key] = obj[key]
        .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
        .replace(/javascript:/gi, "")
        .trim();
    } else if (typeof obj[key] === "object") {
      sanitize(obj[key]);
    }
  }
}

export function sanitizeInput(req, _res, next) {
  sanitize(req.body);
  sanitize(req.query);
  next();
}

// NOTE: all SQL in this codebase uses parameterised queries (mysql2 placeholders),
// so this guard only blocks blatant injection *payloads*, not ordinary English.
// The previous pattern blocked any body containing words like "select", "update",
// "delete", "create", "char" (e.g. a product description "Select your size") and
// used a stateful /g regex with .test(), which made results non-deterministic.
const SQL_PATTERN = /(\bunion\b[\s\S]{0,40}\bselect\b|;\s*(drop|truncate)\s+table|\bxp_cmdshell\b|\binto\s+outfile\b)/i;

export function sqlInjectionGuard(req, res, next) {
  const check = (val) => typeof val === "string" && SQL_PATTERN.test(val);
  const suspicious =
    Object.values(req.body || {}).some(check) ||
    Object.values(req.query || {}).some(check);
  if (suspicious) {
    return res.status(400).json({ error: "Invalid input detected" });
  }
  next();
}

export function enforceHttps(req, res, next) {
  if (process.env.NODE_ENV === "production" && req.headers["x-forwarded-proto"] !== "https") {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
}

export function auditLogger(req, _res, next) {
  if (["POST","PUT","PATCH","DELETE"].includes(req.method)) {
    const user = req.user?.id || "anon";
    console.log(`[AUDIT] ${new Date().toISOString()} ${req.method} ${req.path} user=${user} ip=${req.ip} rid=${req.requestId}`);
  }
  next();
}
