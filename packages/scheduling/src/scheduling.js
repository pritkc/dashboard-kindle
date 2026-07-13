import { computeNextPollSeconds, quietHourBoundary } from "../../domain/src/core.js";

export function calculateWakeDecision(policy, context) {
  const quietBoundary = quietHourBoundary(new Date(context.nowMs), policy.quietHours, policy.timezone);
  const nextPollSeconds = computeNextPollSeconds(policy, {
    ...context,
    nextQuietHourBoundaryMs: quietBoundary
  });
  return {
    mode: policy.manualOnly ? "manual" : "poll",
    nextPollSeconds,
    quietUntil: quietBoundary ? new Date(quietBoundary).toISOString() : null,
    fullRefresh: context.changeCount > 0 && context.changeCount % (policy.fullRefreshInterval ?? 6) === 0
  };
}
