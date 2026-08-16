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

const triggerBuild = async () => {
  const hook = process.env.NETLIFY_BUILD_HOOK;

  if (!hook) {
    console.warn("NETLIFY_BUILD_HOOK is not set; the site will not rebuild.");
    return { triggered: false, reason: "not-configured" };
  }

  const now = Date.now();
  if (now - lastTriggeredAt < COOLDOWN_MS) {
    return { triggered: false, reason: "cooldown" };
  }

  try {
    const response = await fetch(hook, { method: "POST" });
    if (!response.ok) {
      console.error(`Netlify build hook returned ${response.status}.`);
      return { triggered: false, reason: "rejected" };
    }

    lastTriggeredAt = now;
    return { triggered: true };
  } catch (error) {
    console.error("Could not reach the Netlify build hook:", error.message);
    return { triggered: false, reason: "unreachable" };
  }
};

module.exports = { triggerBuild };
