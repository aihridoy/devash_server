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

/**
 * The connection string, either given whole or assembled from its parts.
 *
 * The parts are the better way to set this. A password is pasted into an
 * environment variable by a human, and a password containing @ : / ? # or %
 * silently breaks a URI that is written by hand — a leading # in particular
 * makes the parser discard the rest of the password, the host and every
 * option after it, and the error it eventually produces mentions none of that.
 * Encoding each part here means no password can ever be wrong in that way.
 *
 * MONGODB_URI still wins when it is set, so an existing deployment keeps
 * working untouched.
 */
const connectionString = () => {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const user = process.env.MONGODB_USER;
  const password = process.env.MONGODB_PASSWORD;
  const cluster = process.env.MONGODB_CLUSTER;

  if (!user || !password || !cluster) {
    throw new Error(
      "Set MONGODB_USER, MONGODB_PASSWORD and MONGODB_CLUSTER " +
        "(or a single MONGODB_URI).",
    );
  }

  return (
    `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${cluster}/?retryWrites=true&w=majority`
  );
};

const getClient = () => {
  clientPromise ??= new MongoClient(connectionString(), {
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
