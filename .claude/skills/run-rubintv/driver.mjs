// Headless-Chromium driver for the RubinTV SPA. Screenshots any page of a
// running dev stack (see SKILL.md for launching the stack itself).
//
//   node .claude/skills/run-rubintv/driver.mjs [path] [out.png] [options]
//
//   path       route under the /rubintv/ prefix, e.g. "status" or
//              "summit-usdf/auxtel" (default: "" = home). A full http:// URL
//              is passed through untouched.
//   out.png    output file (default: rubintv-shot.png in the cwd)
//   --port N   vite dev-server port (default 5173)
//   --dark     stamp data-theme="dark" on <html> before shooting
//   --height N viewport height (default 900). The app shell is a 100vh
//              internal scroll container, so Playwright's fullPage cannot
//              capture below the fold — use a tall viewport instead.
//   --wait S   extra CSS selector to await before the shot
//
// Playwright is NOT a web/ dependency; install it un-saved first:
//   npm --prefix web install --no-save playwright
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(repoRoot, "web", "package.json"));
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dark") flags.dark = true;
  else if (args[i] === "--port") flags.port = args[++i];
  else if (args[i] === "--height") flags.height = parseInt(args[++i], 10);
  else if (args[i] === "--wait") flags.wait = args[++i];
  else positional.push(args[i]);
}
const route = positional[0] ?? "";
const out = positional[1] ?? "rubintv-shot.png";
const url = route.startsWith("http")
  ? route
  : `http://localhost:${flags.port ?? 5173}/rubintv/${route.replace(/^\//, "")}`;

const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1280, height: flags.height ?? 900 } })
).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
if (flags.dark) {
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
}
if (flags.wait) await page.waitForSelector(flags.wait, { timeout: 15000 });
// Every view renders a heading once its shell is up; data may still stream in.
await page.waitForSelector("h1, h2, .app-root", { timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({ path: out, fullPage: true });
console.log(`saved ${out} (${url})`);
if (errors.length) {
  console.log("CONSOLE ERRORS:");
  for (const e of errors) console.log("  " + e);
}
await browser.close();
process.exit(errors.length ? 2 : 0);
