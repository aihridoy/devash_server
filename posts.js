const express = require("express");

const { getPosts } = require("./db");
const { requireAuth } = require("./auth");

/**
 * Posts API.
 *
 * Reading published posts is public and unauthenticated, because the thing
 * that reads it most is devash's build: it fetches this list and prerenders
 * every post into static HTML. Visitors never touch this API at all — they
 * are served files. That is deliberate. This service sleeps on Render's free
 * tier and takes around 25 seconds to wake, which is survivable for the person
 * writing a post and unacceptable for someone reading one.
 *
 * Everything that writes requires the admin session.
 */

const STATUSES = ["draft", "published"];

/**
 * Validation mirrors the frontmatter rules in devash's scripts/posts.ts. When
 * the two drift, a post that the dashboard accepts fails the build instead —
 * turning a typo into a broken deploy rather than a form error.
 */
const validate = (body, { partial = false } = {}) => {
  const errors = {};
  const has = (field) => body[field] !== undefined;

  const requireString = (field, min, label) => {
    if (partial && !has(field)) return;

    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      errors[field] = `${label} is required.`;
      return;
    }
    if (min && value.trim().length < min) {
      errors[field] = `${label} must be at least ${min} characters.`;
    }
  };

  requireString("title", 3, "Title");
  requireString("description", 20, "Description");
  requireString("content", 1, "The post");

  if (!partial || has("slug")) {
    const slug = body.slug;
    if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      // The slug becomes a URL and a directory name in the build output, so it
      // is restricted rather than sanitised — anything else is a rejection,
      // not something to quietly rewrite behind the author's back.
      errors.slug =
        "Slug must be lowercase letters, numbers and single hyphens, e.g. mongodb-connection-leak.";
    }
  }

  if (!partial || has("date")) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) {
      errors.date = "Date must be YYYY-MM-DD.";
    } else if (Number.isNaN(new Date(`${body.date}T00:00:00Z`).getTime())) {
      errors.date = "That is not a real date.";
    }
  }

  if (has("status") && !STATUSES.includes(body.status)) {
    errors.status = `Status must be one of ${STATUSES.join(", ")}.`;
  }

  if (has("tags") && !Array.isArray(body.tags)) {
    errors.tags = "Tags must be a list.";
  }

  return errors;
};

/** Only the fields the API owns, so a client cannot set _id or anything else. */
const shape = (body) => ({
  slug: body.slug?.trim(),
  title: body.title?.trim(),
  description: body.description?.trim(),
  content: body.content,
  date: body.date,
  tags: Array.isArray(body.tags)
    ? body.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean)
    : [],
  cover: typeof body.cover === "string" ? body.cover.trim() : undefined,
  coverAlt: typeof body.coverAlt === "string" ? body.coverAlt.trim() : undefined,
  status: STATUSES.includes(body.status) ? body.status : "draft",
});

const publicView = ({ _id, ...post }) => post;

const createPostsRouter = ({ onPublish }) => {
  const router = express.Router();

  /**
   * What the build reads. Published only — a draft must not be reachable by
   * guessing its URL, which it would be if the build prerendered it.
   */
  router.get("/", async (req, res, next) => {
    try {
      const posts = await getPosts();
      const found = await posts
        .find({ status: "published" }, { projection: { _id: 0 } })
        .sort({ date: -1 })
        .toArray();

      res.json({ success: true, posts: found });
    } catch (error) {
      next(error);
    }
  });

  /** The dashboard's list: drafts included. */
  router.get("/all", requireAuth, async (req, res, next) => {
    try {
      const posts = await getPosts();
      const found = await posts.find({}).sort({ date: -1 }).toArray();
      res.json({ success: true, posts: found.map(publicView) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:slug", requireAuth, async (req, res, next) => {
    try {
      const posts = await getPosts();
      const post = await posts.findOne({ slug: req.params.slug });

      if (!post) {
        return res.status(404).json({ success: false, message: "No such post." });
      }

      res.json({ success: true, post: publicView(post) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", requireAuth, async (req, res, next) => {
    try {
      const errors = validate(req.body ?? {});
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ success: false, errors });
      }

      const post = { ...shape(req.body), createdAt: new Date(), updatedAt: new Date() };
      const posts = await getPosts();

      try {
        await posts.insertOne(post);
      } catch (error) {
        // The unique index is what actually enforces this; catching its error
        // is more reliable than checking first, which races with itself.
        if (error?.code === 11000) {
          return res.status(409).json({
            success: false,
            errors: { slug: "A post already uses that slug." },
          });
        }
        throw error;
      }

      if (post.status === "published") await onPublish();
      res.status(201).json({ success: true, post: publicView(post) });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:slug", requireAuth, async (req, res, next) => {
    try {
      const errors = validate(req.body ?? {}, { partial: true });
      if (Object.keys(errors).length > 0) {
        return res.status(400).json({ success: false, errors });
      }

      const posts = await getPosts();
      const existing = await posts.findOne({ slug: req.params.slug });
      if (!existing) {
        return res.status(404).json({ success: false, message: "No such post." });
      }

      const merged = shape({ ...publicView(existing), ...req.body });
      const updated = await posts.findOneAndUpdate(
        { slug: req.params.slug },
        { $set: { ...merged, updatedAt: new Date() } },
        { returnDocument: "after" },
      );

      // A rebuild is needed whenever the live site's copy could now be stale:
      // publishing, editing something already published, or unpublishing it.
      if (merged.status === "published" || existing.status === "published") {
        await onPublish();
      }

      res.json({ success: true, post: publicView(updated) });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:slug", requireAuth, async (req, res, next) => {
    try {
      const posts = await getPosts();
      const deleted = await posts.findOneAndDelete({ slug: req.params.slug });

      if (!deleted) {
        return res.status(404).json({ success: false, message: "No such post." });
      }

      if (deleted.status === "published") await onPublish();
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
};

module.exports = { createPostsRouter, validate };
