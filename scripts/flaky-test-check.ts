const DEFAULT_RUNS = 2;
const TEST_COMMAND = [
  "deno",
  "test",
  "--allow-net",
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--shuffle",
  "src/__tests__/",
];

function parseArgs(args: string[]): number {
  let runs = DEFAULT_RUNS;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--runs") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 2) {
        throw new Error("--runs must be an integer >= 2");
      }
      runs = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return runs;
}

const runs = parseArgs(Deno.args);

for (let run = 1; run <= runs; run += 1) {
  console.log(`Flaky test check run ${run}/${runs}`);
  const command = new Deno.Command(TEST_COMMAND[0], {
    args: TEST_COMMAND.slice(1),
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.output();
  if (!status.success) {
    console.error(`Flaky test check failed on run ${run}/${runs}.`);
    Deno.exit(status.code);
  }
}

console.log(`Flaky test check passed: ${runs} shuffled runs completed.`);
