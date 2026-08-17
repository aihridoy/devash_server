const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");

/**
 * Drives the router over real HTTP with a stand-in collection, so what these
 * tests assert on is the response the dashboard actually receives — including
 * the build status, which the dashboard uses to tell the author whether the
 * post reached the live site or only the database.
 *
 * Run with --experimental-test-module-mocks (see package.json).
 */
let collectionInUse;

// Mocked once for the whole file: Node refuses to mock the same module twice,
// so each test swaps the collection rather than re-declaring the mock.
mock.module("./db.js", {
  namedExports: { getPosts: async () => collectionInUse },
});
mock.module("./auth.js", {
  namedExports: { requireAuth: (_req, _res, next) => next() },
});

const startServer = async ({ collection, onPublish }) => {
  collectionInUse = collection;

  const express = require("express");
  const { createPostsRouter } = require("./posts");

  const app = express();
  app.use(express.json());
  app.use("/api/posts", createPostsRouter({ onPublish }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/api/posts`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const draft = {
  slug: "a-post",
  title: "A post",
  description: "Long enough to satisfy the description rule.",
  content: "Words.",
  date: "2026-08-18",
  status: "draft",
};

const fakeCollection = () => ({
  insertOne: async () => ({ acknowledged: true }),
  findOne: async () => ({ ...draft, status: "published" }),
  findOneAndUpdate: async (_filter, update) => ({ ...draft, ...update.$set }),
  findOneAndDelete: async () => ({ ...draft, status: "published" }),
});

test("tells the dashboard what the build hook did when a post is published", async () => {
  const queued = { triggered: false, reason: "queued" };
  const server = await startServer({
    collection: fakeCollection(),
    onPublish: async () => queued,
  });

  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draft, status: "published" }),
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(body.build, queued);
  } finally {
    await server.close();
  }
});

test("says nothing about a build when the post was saved as a draft", async () => {
  let asked = false;
  const server = await startServer({
    collection: fakeCollection(),
    onPublish: async () => {
      asked = true;
      return { triggered: true };
    },
  });

  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.build, undefined);
    assert.equal(asked, false);
  } finally {
    await server.close();
  }
});

test("reports the build for an edit to an already published post", async () => {
  const server = await startServer({
    collection: fakeCollection(),
    onPublish: async () => ({ triggered: true }),
  });

  try {
    const response = await fetch(`${server.url}/a-post`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "A better title" }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.build, { triggered: true });
  } finally {
    await server.close();
  }
});

test("reports the build for a deleted post, which also has to leave the live site", async () => {
  const server = await startServer({
    collection: fakeCollection(),
    onPublish: async () => ({ triggered: false, reason: "not-configured" }),
  });

  try {
    const response = await fetch(`${server.url}/a-post`, { method: "DELETE" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.build, { triggered: false, reason: "not-configured" });
  } finally {
    await server.close();
  }
});
