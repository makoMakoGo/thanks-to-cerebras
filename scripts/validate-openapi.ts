type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

import { EXPECTED_ROUTES } from "./openapi-routes.ts";

type OperationInfo = {
  operation: JsonObject;
  pathItem: JsonObject;
};

const OPENAPI_PATH = Deno.args[0] ?? "docs/openapi.json";
const METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

const failures: string[] = [];
const doc = await readOpenApi(OPENAPI_PATH);

if (doc) {
  validateDocument(doc);
}

if (failures.length > 0) {
  console.error("OpenAPI check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  Deno.exit(1);
}

console.log(`OpenAPI check passed: ${EXPECTED_ROUTES.length} routes checked.`);

async function readOpenApi(path: string): Promise<JsonObject | null> {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(await Deno.readTextFile(path)) as JsonValue;
  } catch (error) {
    failures.push(`Unable to parse ${path}: ${errorMessage(error)}`);
    return null;
  }
  if (!isObject(parsed)) {
    failures.push(`${path} must contain a JSON object.`);
    return null;
  }
  return parsed;
}

function validateDocument(root: JsonObject): void {
  const openapi = stringProp(root, "openapi");
  if (!openapi?.startsWith("3.")) {
    failures.push("openapi must be a 3.x version string.");
  }

  const paths = objectProp(root, "paths");
  const components = objectProp(root, "components");
  if (!paths) failures.push("paths object is required.");
  if (!components) failures.push("components object is required.");
  if (!paths || !components) return;

  const operations = collectOperations(paths);
  validateRouteCoverage(operations);
  validateOperationIds(operations);
  validateSecurity(operations);
  validatePathParameters(operations, root);
  validateRefs(root);
}

function collectOperations(paths: JsonObject): Map<string, OperationInfo> {
  const operations = new Map<string, OperationInfo>();
  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (!isObject(pathItemValue)) {
      failures.push(`Path ${path} must be an object.`);
      continue;
    }
    for (const [method, operationValue] of Object.entries(pathItemValue)) {
      if (!METHODS.has(method)) continue;
      if (!isObject(operationValue)) {
        failures.push(`${routeKey(method, path)} operation must be an object.`);
        continue;
      }
      operations.set(routeKey(method, path), {
        operation: operationValue,
        pathItem: pathItemValue,
      });
    }
  }
  return operations;
}

function validateRouteCoverage(operations: Map<string, OperationInfo>): void {
  const expectedKeys = new Set(
    EXPECTED_ROUTES.map((route) => routeKey(route.method, route.path)),
  );
  for (const key of expectedKeys) {
    if (!operations.has(key)) failures.push(`Missing route ${key}.`);
  }
  for (const key of operations.keys()) {
    if (!expectedKeys.has(key)) {
      failures.push(`Unexpected documented route ${key}.`);
    }
  }
}

function validateOperationIds(operations: Map<string, OperationInfo>): void {
  const seen = new Map<string, string>();
  for (const [key, { operation }] of operations) {
    const operationId = stringProp(operation, "operationId");
    if (!operationId) {
      failures.push(`${key} must define operationId.`);
      continue;
    }
    const previous = seen.get(operationId);
    if (previous) {
      failures.push(
        `${key} duplicates operationId ${operationId} from ${previous}.`,
      );
    }
    seen.set(operationId, key);

    const responses = objectProp(operation, "responses");
    if (!responses || Object.keys(responses).length === 0) {
      failures.push(`${key} must define at least one response.`);
    }
  }
}

function validateSecurity(operations: Map<string, OperationInfo>): void {
  requireSecurity(operations, "POST /v1/chat/completions", "ProxyBearer");
  requireSecurity(operations, "POST /api/auth/setup", "SetupToken");

  const modelsRoute = operations.get("GET /v1/models")?.operation;
  if (modelsRoute && arrayProp(modelsRoute, "security")) {
    failures.push("GET /v1/models must remain unauthenticated.");
  }

  for (const route of EXPECTED_ROUTES) {
    if (
      !route.path.startsWith("/api/") || route.path.startsWith("/api/auth/")
    ) {
      continue;
    }
    requireSecurity(
      operations,
      routeKey(route.method, route.path),
      "AdminToken",
    );
  }
}

function requireSecurity(
  operations: Map<string, OperationInfo>,
  key: string,
  scheme: string,
): void {
  const operation = operations.get(key)?.operation;
  if (!operation) return;
  if (!hasSecurityScheme(operation, scheme)) {
    failures.push(`${key} must require ${scheme}.`);
  }
}

function validatePathParameters(
  operations: Map<string, OperationInfo>,
  root: JsonObject,
): void {
  for (const route of EXPECTED_ROUTES) {
    const names = pathParameterNames(route.path);
    if (names.length === 0) continue;

    const key = routeKey(route.method, route.path);
    const info = operations.get(key);
    if (!info) continue;

    const documented = new Set(parameterNames(info, root));
    for (const name of names) {
      if (!documented.has(name)) {
        failures.push(`${key} must document path parameter ${name}.`);
      }
    }
  }
}

function validateRefs(root: JsonObject): void {
  const refs: string[] = [];
  collectRefs(root, refs);
  for (const ref of refs) {
    if (resolveRef(root, ref) === undefined) {
      failures.push(`Unresolved $ref ${ref}.`);
    }
  }
}

function parameterNames(info: OperationInfo, root: JsonObject): string[] {
  const values = [
    ...(arrayProp(info.pathItem, "parameters") ?? []),
    ...(arrayProp(info.operation, "parameters") ?? []),
  ];
  const names: string[] = [];
  for (const value of values) {
    const parameter = resolveMaybeRef(root, value);
    if (!isObject(parameter)) continue;
    if (stringProp(parameter, "in") === "path") {
      const name = stringProp(parameter, "name");
      if (name) names.push(name);
    }
  }
  return names;
}

function resolveMaybeRef(
  root: JsonObject,
  value: JsonValue,
): JsonValue | undefined {
  if (!isObject(value)) return value;
  const ref = stringProp(value, "$ref");
  return ref ? resolveRef(root, ref) : value;
}

function collectRefs(value: JsonValue, refs: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return;
  }
  if (!isObject(value)) return;

  const ref = stringProp(value, "$ref");
  if (ref) refs.push(ref);
  for (const child of Object.values(value)) collectRefs(child, refs);
}

function resolveRef(root: JsonObject, ref: string): JsonValue | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: JsonValue | undefined = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isObject(current)) {
      current = current[segment];
    } else {
      current = undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function hasSecurityScheme(operation: JsonObject, scheme: string): boolean {
  return (arrayProp(operation, "security") ?? []).some((entry) =>
    isObject(entry) && Array.isArray(entry[scheme])
  );
}

function pathParameterNames(path: string): string[] {
  return Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => match[1]);
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function stringProp(object: JsonObject, key: string): string | null {
  const value = object[key];
  return typeof value === "string" ? value : null;
}

function objectProp(object: JsonObject, key: string): JsonObject | null {
  const value = object[key];
  return isObject(value) ? value : null;
}

function arrayProp(object: JsonObject, key: string): JsonValue[] | null {
  const value = object[key];
  return Array.isArray(value) ? value : null;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
