import { bootstrapState, saveState } from "../apps/server/src/main.js";
import { defaultState } from "../packages/domain/src/core.js";
import { checkRendererDeps } from "./check-renderer-deps.js";

try {
  checkRendererDeps({ quiet: true });
} catch (error) {
  console.error(error.message);
  console.error("Install renderer tools, then run `pnpm check:renderer`.");
  process.exit(1);
}

const state = await bootstrapState(defaultState());
saveState(state);
console.log("Seeded connector snapshots, revisions, render artifacts, and simulator device.");
