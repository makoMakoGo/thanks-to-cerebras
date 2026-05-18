const DEFAULT_PATHS = ["main.ts", "src", "scripts", ".github"];
const DEBT_PATTERN =
  /\b(TODO|FIXME|HACK|XXX)\b(?!(?:\([^)]+\)|:\s*https?:\/\/|:\s*#\d+|:\s*[A-Z]+-\d+))/;
const CHECKED_EXTENSIONS = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".json",
  ".yml",
  ".yaml",
  ".html",
  ".css",
  ".md",
]);
const IGNORED_DIRS = new Set([".git", "coverage", "node_modules"]);

type DebtFinding = {
  file: string;
  line: number;
  text: string;
};

async function collectFiles(path: string): Promise<string[]> {
  const stat = await Deno.stat(path);
  if (stat.isFile) return shouldCheck(path) ? [path] : [];
  if (!stat.isDirectory) return [];

  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    if (entry.isDirectory && IGNORED_DIRS.has(entry.name)) continue;
    files.push(...await collectFiles(`${path}/${entry.name}`));
  }
  return files;
}

function shouldCheck(path: string): boolean {
  return CHECKED_EXTENSIONS.has(extensionOf(path));
}

function extensionOf(path: string): string {
  const fileName = path.split("/").at(-1) ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex);
}

const paths = Deno.args.length > 0 ? Deno.args : DEFAULT_PATHS;
const files = [
  ...new Set((await Promise.all(paths.map(collectFiles))).flat()),
].sort();
const findings: DebtFinding[] = [];

for (const file of files) {
  if (
    file.endsWith("/scripts/tech-debt-check.ts") ||
    file === "scripts/tech-debt-check.ts"
  ) {
    continue;
  }
  const lines = (await Deno.readTextFile(file)).split("\n");
  for (const [index, line] of lines.entries()) {
    if (DEBT_PATTERN.test(line)) {
      findings.push({ file, line: index + 1, text: line.trim() });
    }
  }
}

if (findings.length > 0) {
  console.error(
    "Tech debt check failed. TODO/FIXME/HACK/XXX markers must include an owner, URL, issue, or ticket reference.",
  );
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} ${finding.text}`);
  }
  Deno.exit(1);
}

console.log(`Tech debt check passed: ${files.length} files checked.`);
