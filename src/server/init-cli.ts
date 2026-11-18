import os from "node:os";
import { parseArgs } from "node:util";
import { applyInitPlan, planInit, type InitProvider } from "./init-plan.js";
import { makeItSoDir } from "./load-config.js";
import { DEFAULT_PROVIDER_COMMAND, missingCliMessage, systemPathLookup } from "./agent-cli-check.js";

// Entry point of `npm run init`. A thin wiring layer that reads the arguments and the home directory and hands them to init-plan.ts.
// Everything is created in `~/.make-it-so`.
//   npm run init -- [--provider claude|kiro] [--ship my-ship] [--port 3939]

const USAGE = "Usage: npm run init -- [--provider claude|kiro] [--ship <id>] [--port <number>]";

function main(): number {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        provider: { type: "string", default: "claude" },
        ship: { type: "string", default: "my-ship" },
        port: { type: "string", default: "3939" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  let files;
  try {
    files = planInit({
      provider: values.provider as InitProvider,
      shipId: values.ship,
      port: Number(values.port),
      homeDir: makeItSoDir(os.homedir()),
    });
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }

  const { written, conflicts } = applyInitPlan(files);
  if (conflicts.length > 0) {
    console.error("These files already exist, so nothing was written (existing files are never overwritten):");
    for (const c of conflicts) console.error(`  ${c}`);
    console.error("Remove them, or choose another --ship, and run again.");
    return 1;
  }

  console.log("Created:");
  for (const w of written) console.log(`  ${w}`);

  const provider = values.provider as InitProvider;
  const warning = missingCliMessage(provider, DEFAULT_PROVIDER_COMMAND[provider], systemPathLookup());
  if (warning) console.warn(`\nWarning: ${warning}`);

  console.log(`\nNext: run \`npm run build && npm start\` and open http://127.0.0.1:${values.port}`);
  // The dev server (Vite) port is the backend port + 10000 (see vite.config.ts)
  console.log(`(For development: \`npm run dev\`, then open http://localhost:${Number(values.port) + 10000})`);
  console.log("To add crew members or a persona, edit roster.yml (see config.sample.yml).");
  return 0;
}

process.exit(main());
