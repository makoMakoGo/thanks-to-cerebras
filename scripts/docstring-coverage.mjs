import { parseArgs } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const { values } = parseArgs({
  options: {
    root: {
      type: "string",
      default:
        "src/auth.ts,src/handlers/auth.ts,src/kv/flush.ts,src/kv/model-catalog.ts,src/services/api-keys.ts",
    },
    threshold: { type: "string", default: "80" },
  },
});

const roots = String(values.root).split(",").map((path) => path.trim()).filter(
  (path) => path.length > 0,
);
const threshold = Number(values.threshold);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  throw new Error(`Invalid docstring coverage threshold: ${values.threshold}`);
}

const exportedFunctionPatterns = [
  /(?:^|\n)export\s+(?:default\s+)?(?:async\s+)?function(?:\s*\*)?(?:\s+([A-Za-z_$][\w$]*))?\s*\(/g,
  /(?:^|\n)export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function(?:\s*\*)?(?:\s+[A-Za-z_$][\w$]*)?\s*\(|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g,
  /(?:^|\n)export\s+default\s+(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
];

async function collectTsFiles(path) {
  const stat = await Deno.stat(path);
  if (stat.isFile) return path.endsWith(".ts") ? [path] : [];
  if (!stat.isDirectory) return [];

  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "__tests__" || entry.name === "ui") continue;
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTsFiles(childPath));
    } else if (entry.isFile() && childPath.endsWith(".ts")) {
      files.push(childPath);
    }
  }
  return files;
}

function hasDocComment(source, index) {
  const declarationStart = source[index] === "\n" ? index + 1 : index;
  const before = source.slice(0, declarationStart).replace(
    /(?:^|\n)[^\n]*$/,
    "",
  );
  return /(?:^|\n)[ \t]*(?:(?:\/\*\*[\s\S]*?\*\/)|(?:\/\/\/[^\n]*(?:\n[ \t]*\/\/\/[^\n]*)*))[ \t]*$/
    .test(
      before,
    );
}

function countMatches(source, pattern) {
  let total = 0;
  let documented = 0;
  for (const match of source.matchAll(pattern)) {
    total += 1;
    if (hasDocComment(source, match.index)) documented += 1;
  }
  return { total, documented };
}

function missingName(match) {
  return match[1] ?? "default";
}

let total = 0;
let documented = 0;
const missing = [];

const files = [
  ...new Set(
    (await Promise.all(roots.map(collectTsFiles))).flat().map((file) =>
      resolve(file)
    ),
  ),
];

for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const pattern of exportedFunctionPatterns) {
    const functions = countMatches(source, pattern);
    total += functions.total;
    documented += functions.documented;

    for (const match of source.matchAll(pattern)) {
      if (!hasDocComment(source, match.index)) {
        const line = source.slice(0, match.index).split("\n").length;
        missing.push(`${file}:${line} ${missingName(match)}`);
      }
    }
  }
}

const coverage = total === 0 ? 100 : documented / total * 100;
console.log(
  `Docstring coverage: ${coverage.toFixed(2)}% (${documented}/${total})`,
);

if (coverage < threshold) {
  console.error(`Required threshold: ${threshold.toFixed(2)}%`);
  for (const item of missing.slice(0, 50)) {
    console.error(`missing ${item}`);
  }
  if (missing.length > 50) {
    console.error(`... ${missing.length - 50} more`);
  }
  process.exit(1);
}
