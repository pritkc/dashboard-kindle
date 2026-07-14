import { runSimulatorOnce, simulatorConfigFromEnv } from "./client.js";

const result = await runSimulatorOnce(simulatorConfigFromEnv());
console.log(JSON.stringify(result, null, 2));
if (result.status === "offline") {
  process.exitCode = 2;
}
