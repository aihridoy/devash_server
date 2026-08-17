/**
 * Publishing a post has to reach the reader, and readers are served static
 * files built by Netlify — so a write here means nothing until a build runs.
 * This asks Netlify for one.
 *
 * Deliberately best-effort: if the hook is unset or Netlify is unreachable,
 * the post is still saved and the request still succeeds. Losing the writing
 * because a deploy trigger failed would be the worse outcome by far, and a
 * build can always be started by hand from Netlify's dashboard.
 */

/** Netlify coalesces builds, but there is no reason to queue several a minute. */
const COOLDOWN_MS = 60 * 1000;

let lastTriggeredAt = 0;
/** The build a publish inside the cooldown asked for, waiting for it to end. */
let queuedBuild = null;

const askNetlify = async (hook) => {
  try {
    const response = await fetch(hook, { method: "POST" });
    if (!response.ok) {
      console.error(`Netlify build hook returned ${response.status}.`);
      return { triggered: false, reason: "rejected" };
    }

    lastTriggeredAt = Date.now();
    return { triggered: true };
  } catch (error) {
    console.error("Could not reach the Netlify build hook:", error.message);
    return { triggered: false, reason: "unreachable" };
  }
};

const triggerBuild = async () => {
  const hook = process.env.NETLIFY_BUILD_HOOK;

  if (!hook) {
    console.warn("NETLIFY_BUILD_HOOK is not set; the site will not rebuild.");
    return { triggered: false, reason: "not-configured" };
  }

  const waited = Date.now() - lastTriggeredAt;
  if (waited < COOLDOWN_MS) {
    // Dropping this request would lose the post: the build already running
    // started before the post was written and cannot contain it, and nothing
    // else would ever ask for another one. So the cooldown delays a build
    // rather than cancelling it, and several publishes in the same minute
    // still cost exactly one.
    if (!queuedBuild) {
      queuedBuild = setTimeout(() => {
        queuedBuild = null;
        askNetlify(hook);
      }, COOLDOWN_MS - waited);

      // A pending build should not keep the process alive on its own.
      queuedBuild.unref?.();
    }

    return { triggered: false, reason: "queued" };
  }

  return askNetlify(hook);
};

module.exports = { triggerBuild };
