const { MongoClient } = require("mongodb");

/**
 * One client for the process, created on first use.
 *
 * A client per request is how a small app quietly exhausts its Atlas
 * connection limit: every client opens its own pool, and on a platform that
 * runs several instances those pools multiply. The pool is also capped well
 * below the free tier's ceiling for the same reason.
 */

let clientPromise;

const getClient = () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set.");
  }

  clientPromise ??= new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 10,
  }).connect();

  return clientPromise;
};

const getDatabase = async () => {
  const client = await getClient();
  return client.db(process.env.MONGODB_DB || "devash");
};

const getPosts = async () => {
  const database = await getDatabase();
  const posts = database.collection("posts");

  // Slugs are the URL, so two posts can never share one. Creating the index
  // here means the guarantee holds even if a write path forgets to check.
  await posts.createIndex({ slug: 1 }, { unique: true });
  await posts.createIndex({ status: 1, date: -1 });

  return posts;
};

module.exports = { getDatabase, getPosts };
