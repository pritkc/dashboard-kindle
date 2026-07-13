import { bootstrapState, loadState, saveState } from "../apps/server/src/main.js";

const state = await bootstrapState(loadState());
saveState(state);
console.log("Seeded connector snapshots, revisions, render artifacts, and simulator device.");
