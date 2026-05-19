const AGENTS_PATH = "AGENTS.md";
const REQUIRED_SNIPPETS = [
  "# Repository Instructions",
  "## Scope",
  "## Architecture",
  "## Validation",
  "## Security",
  "deno task fmt:check",
  "deno task lint",
  "deno task naming:check",
  "deno task complexity:check",
  "deno task module-boundaries:check",
  "deno task agents:check",
  "deno task large-files:check",
  "deno task tech-debt:check",
  "deno task duplicate-code:check",
  "deno task unused-deps:check",
  "deno task openapi:check",
  "deno task check",
  "deno task test:ci",
  "deno task coverage:lcov",
  "deno task coverage:check",
  "deno task test:performance",
  "deno task dast:check",
  "Never commit plaintext",
  "Never log secrets",
];
const DISALLOWED_MARKERS = [
  String.raw`\bTO` + String.raw`DO\b`,
  String.raw`\bFIX` + String.raw`ME\b`,
  String.raw`\bHA` + String.raw`CK\b`,
  String.raw`\bX` + String.raw`XX\b`,
];

let content = "";
try {
  content = await Deno.readTextFile(AGENTS_PATH);
} catch (error) {
  console.error(`AGENTS check failed: cannot read ${AGENTS_PATH}.`);
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}

const failures = REQUIRED_SNIPPETS.filter((snippet) =>
  !content.includes(snippet)
);

if (new RegExp(DISALLOWED_MARKERS.join("|"), "i").test(content)) {
  failures.push("AGENTS.md must not contain unresolved debt markers.");
}

if (failures.length > 0) {
  console.error("AGENTS check failed:");
  for (const failure of failures) {
    console.error(`- Missing or invalid: ${failure}`);
  }
  Deno.exit(1);
}

console.log("AGENTS check passed.");
