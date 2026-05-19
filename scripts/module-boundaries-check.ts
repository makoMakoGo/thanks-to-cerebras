const PRODUCTION_PATHS = ["main.ts", "src"];
const IGNORED_DIRS = new Set([".git", "coverage", "node_modules"]);
const IMPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;

type Layer =
  | "entry"
  | "app"
  | "handler"
  | "service"
  | "kv"
  | "ui"
  | "domain"
  | "test";

type Violation = {
  file: string;
  specifier: string;
  reason: string;
};

const violations: Violation[] = [];

for (const file of await collectFiles(PRODUCTION_PATHS)) {
  if (!shouldCheck(file)) continue;
  const sourceLayer = layerOf(file);
  if (sourceLayer === "test") continue;

  const source = await Deno.readTextFile(file);
  for (const specifier of importSpecifiers(source)) {
    const target = resolveRelativeImport(file, specifier);
    if (!target) continue;
    const targetLayer = layerOf(target);
    const reason = boundaryViolation(sourceLayer, targetLayer);
    if (reason) violations.push({ file, specifier, reason });
  }
}

if (violations.length > 0) {
  console.error("Module boundary check failed.");
  for (const violation of violations) {
    console.error(
      `- ${violation.file} imports ${violation.specifier}: ${violation.reason}`,
    );
  }
  Deno.exit(1);
}

console.log("Module boundary check passed.");

async function collectFiles(paths: string[]): Promise<string[]> {
  const files = await Promise.all(paths.map(collectPath));
  return [...new Set(files.flat())].sort();
}

async function collectPath(path: string): Promise<string[]> {
  const stat = await Deno.stat(path);
  if (stat.isFile) return [path];
  if (!stat.isDirectory) return [];

  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    if (entry.isDirectory && IGNORED_DIRS.has(entry.name)) continue;
    files.push(...await collectPath(`${path}/${entry.name}`));
  }
  return files;
}

function shouldCheck(file: string): boolean {
  return file.endsWith(".ts") && !file.endsWith(".d.ts");
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveRelativeImport(
  importer: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = importer.split("/").slice(0, -1).join("/");
  const normalized = normalizePath(`${base}/${specifier}`);
  if (normalized.endsWith(".ts")) return normalized;
  return `${normalized}.ts`;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function layerOf(file: string): Layer {
  if (file === "main.ts") return "entry";
  if (file.startsWith("src/__tests__/")) return "test";
  if (file === "src/app.ts") return "app";
  if (["src/router.ts", "src/http.ts"].includes(file)) return "domain";
  if (file.startsWith("src/handlers/")) return "handler";
  if (file.startsWith("src/services/")) return "service";
  if (file.startsWith("src/kv/")) return "kv";
  if (file.startsWith("src/ui/")) return "ui";
  return "domain";
}

function boundaryViolation(source: Layer, target: Layer): string | null {
  if (target === "test") return "production code must not import tests";
  if (source === "entry" && !["app", "domain", "kv"].includes(target)) {
    return "entrypoint may only compose app, domain, and KV bootstrap modules";
  }
  if (source === "app" && ["service", "kv"].includes(target)) {
    return "app layer should reach services/KV only through handlers";
  }
  if (source === "handler" && ["app", "ui"].includes(target)) {
    return "handlers must not depend on app routing or UI";
  }
  if (source === "service" && ["app", "handler", "ui"].includes(target)) {
    return "services must not depend on app, handler, or UI layers";
  }
  if (source === "kv" && ["app", "handler", "service", "ui"].includes(target)) {
    return "KV layer must stay below services and handlers";
  }
  if (source === "ui" && ["app", "handler", "service", "kv"].includes(target)) {
    return "UI layer must stay independent of app, handler, service, and KV";
  }
  return null;
}
