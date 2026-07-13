# Widget Development

Widgets receive resolved data, stale/error/missing state, and the target device profile. A widget must handle missing data, stale data, partial data, errors, long text, Unicode, small layouts, monochrome output, and grayscale output.

The initial widget set includes text, metric, progress, status, list, activity bars, clock/date, and alert widgets. The contract is intentionally data-shape oriented so a progress widget can render Codex usage, screen-time goals, battery, or storage without connector-specific code.
