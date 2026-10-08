import multer from "multer";

const ALLOWED_MIME = new Set(["image/jpeg","image/png","image/webp","image/gif"]);
const ALLOWED_DOC  = new Set(["image/jpeg","image/png","application/pdf"]);

function imageFilter(req, file, cb) {
  ALLOWED_MIME.has(file.mimetype)
    ? cb(null, true)
    : cb(new Error("Only JPEG, PNG, WEBP images are allowed"), false);
}

function docFilter(req, file, cb) {
  ALLOWED_DOC.has(file.mimetype)
    ? cb(null, true)
    : cb(new Error("Only images and PDFs are allowed"), false);
}

// Single image upload (in-memory)
export const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: imageFilter,
});

// Multiple images
export const uploadImages = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: imageFilter,
});

// Documents (ID, license, etc.)
export const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: docFilter,
});
