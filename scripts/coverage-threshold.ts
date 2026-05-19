type Thresholds = {
  lineThreshold: number;
};

type CoverageTotals = {
  lineFound: number;
  lineHit: number;
  functionFound: number;
  functionHit: number;
  branchFound: number;
  branchHit: number;
};

function parseArgs(
  args: string[],
): { lcovPath: string; thresholds: Thresholds } {
  let lcovPath = "coverage/coverage.lcov";
  let lineThreshold = 75;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--line-threshold") {
      lineThreshold = parsePercent(args[index + 1], "--line-threshold");
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) {
      lcovPath = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { lcovPath, thresholds: { lineThreshold } };
}

function parsePercent(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${name} must be a number between 0 and 100`);
  }
  return parsed;
}

function addMetric(
  totals: CoverageTotals,
  key: keyof CoverageTotals,
  value: string,
): void {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed)) totals[key] += parsed;
}

function parseLcov(source: string): CoverageTotals {
  const totals: CoverageTotals = {
    lineFound: 0,
    lineHit: 0,
    functionFound: 0,
    functionHit: 0,
    branchFound: 0,
    branchHit: 0,
  };

  for (const line of source.split("\n")) {
    const [key, value] = line.split(":", 2);
    if (value === undefined) continue;

    if (key === "LF") addMetric(totals, "lineFound", value);
    if (key === "LH") addMetric(totals, "lineHit", value);
    if (key === "FNF") addMetric(totals, "functionFound", value);
    if (key === "FNH") addMetric(totals, "functionHit", value);
    if (key === "BRF") addMetric(totals, "branchFound", value);
    if (key === "BRH") addMetric(totals, "branchHit", value);
  }

  return totals;
}

function percent(hit: number, found: number): number {
  return found === 0 ? 100 : hit / found * 100;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

const { lcovPath, thresholds } = parseArgs(Deno.args);
const totals = parseLcov(await Deno.readTextFile(lcovPath));

if (totals.lineFound === 0) {
  console.error(
    `Coverage check failed: no line coverage found in ${lcovPath}.`,
  );
  Deno.exit(1);
}

const lineCoverage = percent(totals.lineHit, totals.lineFound);
const functionCoverage = percent(totals.functionHit, totals.functionFound);
const branchCoverage = percent(totals.branchHit, totals.branchFound);

console.log(
  `Coverage: lines ${
    formatPercent(lineCoverage)
  } (${totals.lineHit}/${totals.lineFound}), ` +
    `functions ${
      formatPercent(functionCoverage)
    } (${totals.functionHit}/${totals.functionFound}), ` +
    `branches ${
      formatPercent(branchCoverage)
    } (${totals.branchHit}/${totals.branchFound}).`,
);

if (lineCoverage < thresholds.lineThreshold) {
  console.error(
    `Coverage check failed: line coverage ${
      formatPercent(lineCoverage)
    } is below ${formatPercent(thresholds.lineThreshold)}.`,
  );
  Deno.exit(1);
}

console.log(
  `Coverage check passed: line coverage threshold ${
    formatPercent(thresholds.lineThreshold)
  }.`,
);
