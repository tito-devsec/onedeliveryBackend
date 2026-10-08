import { Readable } from "stream";
import cloudinary from "../config/cloudinary.js";

export async function uploadBuffer(buffer, folder = "onedelivery") {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", quality: "auto", fetch_format: "auto" },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    Readable.from(buffer).pipe(stream);
  });
}

export async function uploadMultiple(files, folder = "onedelivery") {
  return Promise.all(files.map((f) => uploadBuffer(f.buffer, folder)));
}

export async function deleteImage(publicId) {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (e) {
    console.error("cloudinary delete:", e.message);
  }
}
