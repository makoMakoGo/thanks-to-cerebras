type TestCase = {
  name: string;
  className: string;
  timeSeconds: number;
};

function parseArgs(args: string[]): {
  junitPath: string;
  slowThresholdSeconds: number;
} {
  let junitPath = "reports/junit.xml";
  let slowThresholdSeconds = 8;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--slow-threshold") {
      const value = Number(args[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--slow-threshold must be a positive number");
      }
      slowThresholdSeconds = value;
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) {
      junitPath = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { junitPath, slowThresholdSeconds };
}

function getAttribute(source: string, name: string): string {
  const pattern = new RegExp(`${name}="([^"]*)"`);
  return decodeXml(pattern.exec(source)?.[1] ?? "");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function parseTestCases(junit: string): TestCase[] {
  return [...junit.matchAll(/<testcase\b[^>]*>/g)].map((match) => ({
    name: getAttribute(match[0], "name"),
    className: getAttribute(match[0], "classname"),
    timeSeconds: Number(getAttribute(match[0], "time")) || 0,
  }));
}

const { junitPath, slowThresholdSeconds } = parseArgs(Deno.args);
const testCases = parseTestCases(await Deno.readTextFile(junitPath));

if (testCases.length === 0) {
  console.error(
    `Test performance report failed: no test cases found in ${junitPath}.`,
  );
  Deno.exit(1);
}

const totalSeconds = testCases.reduce(
  (sum, testCase) => sum + testCase.timeSeconds,
  0,
);
const slowTests = testCases
  .filter((testCase) => testCase.timeSeconds >= slowThresholdSeconds)
  .sort((left, right) => right.timeSeconds - left.timeSeconds);
const topTests = [...testCases]
  .sort((left, right) => right.timeSeconds - left.timeSeconds)
  .slice(0, 10);

console.log(
  `Test performance: ${testCases.length} tests, ${
    totalSeconds.toFixed(2)
  }s total measured test time.`,
);

if (slowTests.length > 0) {
  console.log(
    `Slow tests (>= ${slowThresholdSeconds}s): ${slowTests.length}`,
  );
  for (const testCase of slowTests) {
    console.log(
      `- ${
        testCase.timeSeconds.toFixed(2)
      }s ${testCase.className} ${testCase.name}`,
    );
  }
}

console.log("Top test durations:");
for (const testCase of topTests) {
  console.log(
    `- ${
      testCase.timeSeconds.toFixed(2)
    }s ${testCase.className} ${testCase.name}`,
  );
}
