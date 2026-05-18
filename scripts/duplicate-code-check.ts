const DEFAULT_PATHS = ["main.ts", "src"];
const DEFAULT_MIN_LINES = 12;
const IGNORED_DIRS = new Set([".git", "coverage", "node_modules"]);

type DuplicateBlock = {
  first: Location;
  second: Location;
};

type Location = {
  file: string;
  line: number;
};

function parseArgs(args: string[]): { minLines: number; paths: string[] } {
  let minLines = DEFAULT_MIN_LINES;
  const paths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--min-lines") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 3) {
        throw new Error("--min-lines must be an integer >= 3");
      }
      minLines = value;
      index += 1;
      continue;
    }
    paths.push(arg);
  }

  return { minLines, paths: paths.length > 0 ? paths : DEFAULT_PATHS };
}

async function collectFiles(path: string): Promise<string[]> {
  if (path.split("/").includes("__tests__")) return [];

  const stat = await Deno.stat(path);
  if (stat.isFile) return path.endsWith(".ts") ? [path] : [];
  if (!stat.isDirectory) return [];

  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    if (entry.isDirectory && IGNORED_DIRS.has(entry.name)) continue;
    files.push(...await collectFiles(`${path}/${entry.name}`));
  }
  return files;
}

function normalizedLines(
  source: string,
): Array<{ line: number; text: string }> {
  const lines = source.split("\n");
  return lines.flatMap((line, index) => {
    const text = line
      .replace(/\/\/.*$/, "")
      .trim()
      .replace(/\s+/g, " ");
    if (
      text.length === 0 ||
      text === "{" ||
      text === "}" ||
      text === "};" ||
      text === "}," ||
      text.startsWith("import ") ||
      text.startsWith("export type ")
    ) {
      return [];
    }
    return [{ line: index + 1, text }];
  });
}

const { minLines, paths } = parseArgs(Deno.args);
const files = [
  ...new Set((await Promise.all(paths.map(collectFiles))).flat()),
].sort();
const seen = new Map<string, Location>();
const duplicates: DuplicateBlock[] = [];

for (const file of files) {
  const lines = normalizedLines(await Deno.readTextFile(file));
  for (let index = 0; index <= lines.length - minLines; index += 1) {
    const block = lines.slice(index, index + minLines)
      .map((line) => line.text)
      .join("\n");
    const location = { file, line: lines[index].line };
    const first = seen.get(block);
    if (first) {
      duplicates.push({ first, second: location });
    } else {
      seen.set(block, location);
    }
  }
}

if (duplicates.length > 0) {
  console.error(
    `Duplicate code check failed. Found duplicated blocks of at least ${minLines} normalized lines.`,
  );
  for (const duplicate of duplicates.slice(0, 20)) {
    console.error(
      `- ${duplicate.first.file}:${duplicate.first.line} duplicates ${duplicate.second.file}:${duplicate.second.line}`,
    );
  }
  if (duplicates.length > 20) {
    console.error(`... ${duplicates.length - 20} more`);
  }
  Deno.exit(1);
}

console.log(
  `Duplicate code check passed: ${files.length} files checked, minimum block ${minLines} lines.`,
);
