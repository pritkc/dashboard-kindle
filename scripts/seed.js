import { bootstrapState, saveState } from "../apps/server/src/main.js";
import { defaultState } from "../packages/domain/src/core.js";

const state = await bootstrapState(defaultState());
saveState(state);
console.log("Seeded connector snapshots, revisions, render artifacts, and simulator device.");
