import path from "node:path";

// The result file path of a crew task is computed in one place so that the writer (crew-runner.ts)
// and the reader/deleter (index.ts) can never drift apart.
// It does not depend on the ship config (config.ts); the directory for result files (`agentsDir`)
// is passed in as an argument.
export function crewResultPath(agentsDir: string, agent: string, taskId: string): string {
  return path.join(agentsDir, agent, "results", `${taskId}.md`);
}
