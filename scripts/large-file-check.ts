type Limits = {
  maxLines: number;
  maxBytes: number;
};

const DEFAULT_PATHS = ["main.ts", "src", "scripts"];
const IGNORED_DIRS = new Set([".git", "coverage", "node_modules"]);
const IGNORED_EXTENSIONS = new Set([
  ".lock",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

const DEFAULT_LIMITS: Limits = { maxLines: 300, maxBytes: 20_000 };
const TEST_LIMITS: Limits = { maxLines: 2_200, maxBytes: 70_000 };
const HTML_LIMITS: Limits = { maxLines: 1_300, maxBytes: 70_000 };

type FileFinding = {
  path: string;
  lines: number;
  bytes: number;
  limits: Limits;
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
  const extension = extensionOf(path);
  if (IGNORED_EXTENSIONS.has(extension)) return false;
  return [".ts", ".js", ".mjs", ".json", ".yml", ".yaml", ".html"].includes(
    extension,
  );
}

function extensionOf(path: string): string {
  const fileName = path.split("/").at(-1) ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex);
}

function limitsFor(path: string): Limits {
  if (path.includes("/__tests__/")) return TEST_LIMITS;
  if (extensionOf(path) === ".html") return HTML_LIMITS;
  return DEFAULT_LIMITS;
}

function countLines(text: string): number {
  return text.length === 0
    ? 0
    : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const paths = Deno.args.length > 0 ? Deno.args : DEFAULT_PATHS;
const files = [
  ...new Set((await Promise.all(paths.map(collectFiles))).flat()),
].sort();
const findings: FileFinding[] = [];

for (const file of files) {
  const bytes = (await Deno.stat(file)).size;
  const text = await Deno.readTextFile(file);
  const lines = countLines(text);
  const limits = limitsFor(file);
  if (lines > limits.maxLines || bytes > limits.maxBytes) {
    findings.push({ path: file, lines, bytes, limits });
  }
}

if (findings.length > 0) {
  console.error("Large file check failed.");
  for (const finding of findings) {
    console.error(
      `- ${finding.path}: ${finding.lines}/${finding.limits.maxLines} lines, ${finding.bytes}/${finding.limits.maxBytes} bytes`,
    );
  }
  Deno.exit(1);
}

console.log(`Large file check passed: ${files.length} files checked.`);
