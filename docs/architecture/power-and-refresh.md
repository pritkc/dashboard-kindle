# Power and Refresh

Connector collection, dashboard rendering, device polling, and physical panel refresh are separate. This lets the server preserve power by returning `304 Not Modified` and lets a Kindle skip redraws when the image hash has not changed.

Source collection is driven by persisted `source.collect` jobs. Each source has its own interval, deterministic jitter, last-run metadata, and exponential backoff after failures. Manual collection updates the same schedule metadata, so the UI can show the next automatic collection accurately.

Device polling is calculated separately from source collection. The device wake strategy chooses the next useful poll from source validity, playlist boundaries, clock-widget boundaries, quiet-hour boundaries, and configured min/max intervals.
