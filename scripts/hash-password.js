#!/usr/bin/env node
/**
 * Turn a password into the bcrypt hash that goes in ADMIN_PASSWORD_HASH.
 *
 *   node scripts/hash-password.js
 *
 * The password is typed at a prompt rather than passed as an argument,
 * because an argument ends up in shell history, in `ps` output and in any
 * process listing on the machine. It is never written to disk here and never
 * printed back.
 */

const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const readline = require("node:readline");

/** bcrypt work factor. 12 is roughly a quarter-second per attempt today. */
const ROUNDS = 12;

/**
 * Read a line from a terminal without echoing it.
 *
 * Raw mode means the terminal hands over each keystroke instead of drawing it,
 * so nothing appears on screen and nothing lands in the scrollback. Two
 * earlier attempts here drove readline instead: the first printed no prompt at
 * all in VS Code's terminal, and the second only worked interactively —
 * piped input reached end-of-file and closed the interface before the second
 * question was asked, so the script exited silently mid-way.
 */
const askHiddenFromTty = (question) =>
  new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const onData = (char) => {
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004": // Ctrl-D
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          resolve(value);
          break;
        case "\u0003": // Ctrl-C should still cancel.
          stdout.write("\n");
          process.exit(130);
          break;
        case "\u007f": // Backspace
        case "\b":
          value = value.slice(0, -1);
          break;
        default:
          // Ignore escape sequences from arrow keys and the like.
          if (char >= " ") value += char;
      }
    };

    stdin.on("data", onData);
  });

/** Piped input, for testing. Nothing is hidden because nothing is typed. */
const readPipedLines = () =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    const lines = [];
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => resolve(lines));
  });

const main = async () => {
  const piped = process.stdin.isTTY ? null : await readPipedLines();
  let index = 0;

  const askHidden = async (question) => {
    if (piped) {
      process.stdout.write(question + "\n");
      return piped[index++] ?? "";
    }
    return askHiddenFromTty(question);
  };

  const password = await askHidden("New admin password: ");

  if (password.length < 12) {
    console.error(
      "\n  Too short. Use at least 12 characters — this is the only credential\n" +
        "  standing in front of the dashboard, and it will be attacked by\n" +
        "  people who never read your site.\n",
    );
    process.exit(1);
  }

  const confirmation = await askHidden("Type it again:      ");

  if (password !== confirmation) {
    console.error("\n  They do not match. Nothing was generated.\n");
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, ROUNDS);
  const secret = crypto.randomBytes(32).toString("hex");

  console.log(
    [
      "",
      "  Paste these into Render (Environment tab). Neither belongs in git.",
      "",
      `  ADMIN_PASSWORD_HASH=${hash}`,
      "",
      `  SESSION_SECRET=${secret}`,
      "",
      "  The password itself was not stored anywhere by this script.",
      "",
    ].join("\n"),
  );
};

main();
