import { readJson, repoPath } from "../../../packages/domain/src/core.js";

const codex = readJson(repoPath("data/fixtures/codexbar.json"), {});
const activity = readJson(repoPath("data/fixtures/activitywatch.json"), {});

console.log(JSON.stringify({
  status: "ok",
  mode: "fixture",
  privacy: "ActivityWatch raw window titles are not exported by default.",
  codexbar: codex,
  activitywatch: {
    activeMinutes: activity.activeMinutes,
    codingMinutes: activity.codingMinutes,
    topApplications: activity.topApplications
  }
}, null, 2));
