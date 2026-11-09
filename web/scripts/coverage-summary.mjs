// Turns Vitest's coverage-summary.json (the json-summary reporter) into the
// Markdown that CI appends to the GitHub job summary: the totals, then every
// file short of full coverage, weakest first. Run from web/ after the tests:
//   node scripts/coverage-summary.mjs >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from "node:fs";
import process from "node:process";

const METRICS = ["statements", "branches", "functions", "lines"];
const HEAD = [
  "| File | Statements | Branches | Functions | Lines |",
  "|---|---:|---:|---:|---:|",
];

const { total, ...files } = JSON.parse(
  readFileSync("coverage/coverage-summary.json", "utf8"),
);
const row = (name, m) =>
  `| ${name} | ${METRICS.map((k) => `${m[k].pct}%`).join(" | ")} |`;

// Keys are absolute paths; show them relative to web/. Type-only modules have
// no statements and an arbitrary pct (0 or 100 from run to run), so skip them.
const short = Object.entries(files)
  .map(([path, m]) => [path.replace(`${process.cwd()}/`, ""), m])
  .filter(([, m]) => m.statements.total > 0)
  .filter(([, m]) => METRICS.some((k) => m[k].pct < 100))
  .sort(
    ([a, x], [b, y]) =>
      x.statements.pct - y.statements.pct || a.localeCompare(b),
  );

process.stdout.write(
  [
    `## Frontend coverage: ${total.statements.pct}% of statements`,
    "",
    ...HEAD,
    row("**All files**", total),
    "",
    `<details><summary>${short.length} files below 100%</summary>`,
    "",
    ...HEAD,
    ...short.map(([path, m]) => row(path, m)),
    "",
    "</details>",
    "",
  ].join("\n"),
);
