# Architecture Overview

Dashboard Kindle is split into explicit boundaries:

* Connectors collect data and produce immutable source snapshots.
* Dashboard revisions store complete declarative dashboard definitions and hashes.
* The renderer turns a revision plus snapshots and a device profile into immutable artifacts.
* Device protocol endpoints publish the assigned image to thin clients with scoped bearer tokens.
* Scheduling calculates next useful polling without depending on a Kindle clock.

The current implementation stores state in `data/dashboard-kindle.sqlite` with SQLite WAL mode and artifacts in `data/artifacts`. The package layout mirrors the intended long-term monorepo boundaries.
