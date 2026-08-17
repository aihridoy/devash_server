const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * Each test needs a build hook that has never run, so the module is loaded
 * fresh rather than carrying the previous test's cooldown into this one.
 */
const loadFresh = () => {
  delete require.cache[require.resolve("./build-hook")];
  return require("./build-hook");
};

/** Records every POST the hook makes, and lets a test answer them. */
const recordFetch = (respond = async () => ({ ok: true, status: 200 })) => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return respond();
  };
  return calls;
};

const originalFetch = global.fetch;
const originalHook = process.env.NETLIFY_BUILD_HOOK;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalHook === undefined) delete process.env.NETLIFY_BUILD_HOOK;
  else process.env.NETLIFY_BUILD_HOOK = originalHook;
});

test("reports that nothing will rebuild when no hook is configured", async () => {
  delete process.env.NETLIFY_BUILD_HOOK;
  const calls = recordFetch();

  const result = await loadFresh().triggerBuild();

  assert.deepEqual(result, { triggered: false, reason: "not-configured" });
  assert.equal(calls.length, 0);
});

test("asks Netlify for a build on the first publish", async () => {
  process.env.NETLIFY_BUILD_HOOK = "https://hook.example/build";
  const calls = recordFetch();

  const result = await loadFresh().triggerBuild();

  assert.deepEqual(result, { triggered: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hook.example/build");
  assert.equal(calls[0].options.method, "POST");
});

test("queues a publish made during the cooldown instead of dropping it", async (t) => {
  process.env.NETLIFY_BUILD_HOOK = "https://hook.example/build";
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const calls = recordFetch();
  const { triggerBuild } = loadFresh();

  await triggerBuild();
  t.mock.timers.tick(1_000);
  const second = await triggerBuild();

  assert.deepEqual(second, { triggered: false, reason: "queued" });
  assert.equal(calls.length, 1, "the queued build must not go out immediately");

  t.mock.timers.tick(60_000);
  await Promise.resolve();

  assert.equal(calls.length, 2, "the queued build must go out once the cooldown ends");
});

test("collapses several publishes during one cooldown into a single build", async (t) => {
  process.env.NETLIFY_BUILD_HOOK = "https://hook.example/build";
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const calls = recordFetch();
  const { triggerBuild } = loadFresh();

  await triggerBuild();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1_000);
    await triggerBuild();
  }

  t.mock.timers.tick(60_000);
  await Promise.resolve();

  assert.equal(calls.length, 2);
});

test("reports a hook Netlify refused", async () => {
  process.env.NETLIFY_BUILD_HOOK = "https://hook.example/build";
  recordFetch(async () => ({ ok: false, status: 404 }));

  const result = await loadFresh().triggerBuild();

  assert.deepEqual(result, { triggered: false, reason: "rejected" });
});

test("reports a hook that could not be reached", async () => {
  process.env.NETLIFY_BUILD_HOOK = "https://hook.example/build";
  global.fetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };

  const result = await loadFresh().triggerBuild();

  assert.deepEqual(result, { triggered: false, reason: "unreachable" });
});

test("a refused build does not start a cooldown that swallows the next attempt", async (t) => {
  process.env.NETLIFY_BUILD_HOOK = "https://hook.example/build";
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let ok = false;
  const calls = recordFetch(async () => ({ ok, status: ok ? 200 : 500 }));
  const { triggerBuild } = loadFresh();

  await triggerBuild();
  ok = true;
  const second = await triggerBuild();

  assert.deepEqual(second, { triggered: true });
  assert.equal(calls.length, 2);
});
