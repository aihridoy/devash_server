#!/usr/bin/env node
/**
 * Turn a password into the bcrypt hash that goes in ADMIN_PASSWORD_HASH.
 *
 *   node scripts/hash-password.js
 *
 * The password is read from a hidden prompt rather than taken as an argument,
 * because an argument ends up in shell history, in `ps` output, and in any
 * process listing on the machine. It is never written to disk here and never
 * printed back.
 *
 * Paste only the hash into Render. The hash is not a secret in the way the
 * password is — it cannot be reversed — but there is no reason to spread it
 * around either.
 */

const bcrypt = require("bcryptjs");
const readline = require("node:readline");

/** bcrypt work factor. 12 is roughly a quarter-second per attempt today. */
const ROUNDS = 12;

const askHidden = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Swallow the echo so the password never appears on screen or in a
    // scrollback someone else can read.
    const onData = (char) => {
      if (["\n", "\r", ""].includes(char.toString())) {
        process.stdin.removeListener("data", onData);
        return;
      }
      process.stdout.write("[2K[200D" + question);
    };

    process.stdout.write(question);
    process.stdin.on("data", onData);

    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });

const main = async () => {
  const password = await askHidden("New admin password: ");

  if (password.length < 12) {
    console.error(
      "\n  Too short. Use at least 12 characters — this is the only credential\n" +
        "  standing in front of the dashboard, and it will be attacked by\n" +
        "  people who never read your site.\n",
    );
    process.exit(1);
  }

  const confirmation = await askHidden("Type it again: ");
  if (password !== confirmation) {
    console.error("\n  They do not match. Nothing was generated.\n");
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, ROUNDS);
  const secret = require("node:crypto").randomBytes(32).toString("hex");

  console.log(
    [
      "",
      "  Set these in Render (Environment tab). Neither belongs in git.",
      "",
      `  ADMIN_EMAIL=${process.env.ADMIN_EMAIL || "you@example.com"}`,
      `  ADMIN_PASSWORD_HASH=${hash}`,
      `  SESSION_SECRET=${secret}`,
      "",
      "  The password itself was not stored anywhere by this script.",
      "",
    ].join("\n"),
  );
};

main();
