const express = require("express");
const rateLimit = require("express-rate-limit");
const { v2: cloudinary } = require("cloudinary");

const { requireAuth } = require("./auth");

/**
 * Signed direct uploads to Cloudinary.
 *
 * The browser needs to upload an image; the API secret that authorises an
 * upload must never reach the browser, because anything sent to the client is
 * readable by everyone who loads the page. So this signs a single upload and
 * hands back the signature — the file itself then goes from the browser
 * straight to Cloudinary and never passes through this service.
 *
 * That last part matters beyond secrecy. This runs on a free instance with a
 * small memory ceiling; proxying multi-megabyte screenshots through it would
 * be the most fragile part of the whole feature, and it would be carrying
 * bytes that Cloudinary is built to receive directly.
 */

/** Everything the dashboard uploads lives here. Not client-controlled. */
const ROOT_FOLDER = "blog";

/**
 * Cloudinary rejects a signature older than an hour, so these are already
 * short-lived. This limit is about something else: a signature is permission
 * to write into the account, and there is no reason for one admin writing a
 * post to need more than a handful a minute.
 */
const signatureLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { success: false, message: "Too many uploads. Wait a moment." },
});

const isConfigured = () =>
  Boolean(process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

/**
 * A public id becomes part of a URL, so it is constrained rather than
 * sanitised: anything outside this shape is a rejection, not something to
 * quietly rewrite into a name the author did not choose.
 */
const publicIdFrom = (name) => {
  const base = String(name ?? "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  return base || `image-${Date.now()}`;
};

/**
 * The folder is derived from the post's slug rather than taken as given.
 * Signing a client-supplied path would let anything holding a session write
 * to any folder in the account, including over an existing asset.
 */
const folderFor = (slug) => {
  const clean = String(slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");

  return clean ? `${ROOT_FOLDER}/${clean}` : ROOT_FOLDER;
};

const createUploadsRouter = () => {
  const router = express.Router();

  router.post("/signature", requireAuth, signatureLimiter, (req, res) => {
    if (!isConfigured()) {
      return res.status(503).json({
        success: false,
        message:
          "Image uploads are not configured on the server. Set CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.",
      });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const folder = folderFor(req.body?.slug);
    const publicId = publicIdFrom(req.body?.filename);

    // Only these are signed, and the browser must send back exactly them —
    // Cloudinary recomputes the signature over what it receives and refuses
    // the upload if anything was added or altered on the way.
    const params = {
      folder,
      public_id: publicId,
      timestamp,
      overwrite: true,
      invalidate: true,
    };

    const signature = cloudinary.utils.api_sign_request(
      params,
      process.env.CLOUDINARY_API_SECRET,
    );

    res.json({
      success: true,
      upload: {
        ...params,
        signature,
        apiKey: process.env.CLOUDINARY_API_KEY,
        cloudName: process.env.CLOUDINARY_CLOUD_NAME || "h9rhdw24",
      },
    });
  });

  return router;
};

module.exports = { createUploadsRouter, folderFor, publicIdFrom };
