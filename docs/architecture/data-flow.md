# Data Flow

```mermaid
flowchart LR
  Source["Connector instance"] --> Snapshot["Immutable source snapshot"]
  Snapshot --> Revision["Dashboard revision"]
  Revision --> Render["Render fingerprint"]
  Render --> Artifact["PNG/PGM artifact"]
  Artifact --> Device["Thin e-ink client"]
  Device --> ETag["ETag / 304 cache validation"]
```

Each layer keeps last-known-good output. Connector failures do not delete prior snapshots. Render failures do not delete prior artifacts. Device failures leave the previous screen in place.
