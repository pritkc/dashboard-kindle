You are the autonomous principal engineer, product architect, security engineer, QA lead, DevOps engineer, and technical writer for this project.

Your mission is to design, implement, test, document, package, and leave running a production-quality, self-hosted universal e-ink dashboard system. Continue working until the repository contains the most complete working version achievable in the current environment.

Do not merely produce a plan, scaffold, pseudocode, TODO list, or architectural essay. Build the application, run it, exercise it, fix failures, and leave verifiable working artifacts.

## 1. Product objective

Build an open, extensible dashboard platform that can display arbitrary user-selected data on Kindle and other e-ink screens.

The computer-side control plane must let users:

* Connect arbitrary data sources.
* Create and edit dashboards.
* Preview the exact e-ink output.
* Select a device or custom screen resolution.
* Assign dashboards or playlists to devices.
* Configure collection, rendering, polling, sleep, wake, quiet-hour, rotation, contrast, dithering, and refresh behavior.
* Add future connectors and widgets without modifying unrelated core code.

Example data sources include:

* CodexBar usage and quota data.
* ActivityWatch daily screen activity.
* HTTP JSON APIs.
* Webhooks.
* RSS or Atom feeds.
* Local commands returning JSON.
* JSON or CSV files.
* Static/manual data.
* GitHub, calendars, weather, Home Assistant, and future private integrations.

The Kindle must remain a thin, robust display client. It should fetch, validate, cache, and display rendered images without knowing anything about widgets or connector-specific data.

## 2. Autonomy rules

Operate autonomously.

Do not ask me routine questions about:

* Naming.
* Folder structure.
* Framework selections.
* Ports.
* Styling details.
* Test organization.
* Database design.
* Reasonable defaults.
* Whether to proceed to the next phase.

Inspect the environment, repository state, installed tools, existing files, and available credentials before deciding.

Make reasonable, documented assumptions where information is missing.

Only stop for an issue that genuinely cannot be resolved without one of the following:

* A secret or account credential that cannot be substituted with fixtures.
* Explicit authorization for a destructive external action.
* Physical access to hardware that cannot be simulated.

Even then, complete every unaffected part first. Add a working mock, simulator, fixture, or adapter so the project remains runnable.

Do not declare completion while tests, builds, type checks, migrations, startup, or core acceptance tests are failing.

Do not hide failures. Fix them where possible and report remaining hardware-only or credential-only limitations precisely at the end.

Use parallel agents or delegated workstreams when supported, but remain responsible for integrating and verifying their output.

## 3. Research responsibility

Independently inspect current upstream repositories, official documentation, licenses, relevant Kindle/KUAL conventions, e-ink rendering practices, and maintained libraries before making irreversible architectural decisions.

Relevant starting references include:

* `https://github.com/usetrmnl/inker`
* `https://github.com/usetrmnl/byos_next`
* `https://github.com/usetrmnl/byos_node_lite`
* `https://github.com/thecodedose/kdashboard`
* `https://github.com/steipete/CodexBar`
* ActivityWatch REST API documentation

Treat these as references, not unquestionable requirements.

Evaluate whether extending Inker remains the fastest robust option. Inker is AGPL-3.0, so preserve and comply with all license obligations if any of its code is used or modified.

Do not copy code from an unlicensed repository. For `thecodedose/kdashboard`, use architectural ideas only unless a valid license or explicit permission is present.

Record major decisions as concise Architecture Decision Records under `docs/adr/`.

Prefer maintained, documented libraries over custom implementations, but avoid unnecessary infrastructure and fragile dependencies.

## 4. Default technical direction

Use this as the provisional architecture, but improve it when research or implementation evidence justifies a better choice.

* TypeScript monorepo.
* `pnpm` workspaces.
* NestJS backend.
* React frontend.
* SQLite with WAL mode for the first deployment.
* Prisma if extending Inker already uses it cleanly.
* JSON Schema for connector and widget configuration.
* Ajv for server-side schema validation.
* `@rjsf/core` or another mature JSON-Schema form generator.
* GridStack.js or another mature grid-layout editor.
* JSONata for safe data selection and transformation.
* LiquidJS for controlled templates.
* Playwright or Puppeteer with a pinned Chromium version for exact dashboard screenshots.
* Sharp for resizing, grayscale conversion, palette quantization, and image output.
* Satori or an equivalent browser-independent renderer only for system fallback screens.
* HTTPS polling with ETag for Kindle/device delivery.
* SQLite-backed durable jobs instead of Redis initially.
* One deployable server container and one persistent data volume.
* A separate outbound-only local agent for private Mac-local data.
* KUAL shell client plus the smallest necessary native helper for Kindle display control.
* Vitest or Jest for TypeScript tests.
* Playwright for browser end-to-end tests.
* Golden-image tests for e-ink rendering.
* Docker Compose for local deployment.

Avoid adding Redis, Kafka, Kubernetes, GraphQL, distributed workers, or microservices unless a demonstrated requirement makes them necessary.

## 5. Required architecture

Design explicit boundaries around the following concepts.

### 5.1 Domain and application core

The domain layer must not depend directly on:

* NestJS.
* Prisma.
* React.
* Playwright or Puppeteer.
* Sharp.
* Kindle-specific APIs.

Use dependency inversion and composition.

Avoid speculative abstractions, deep inheritance, and generic “manager” classes.

Use interfaces where multiple implementations or external boundaries genuinely exist.

Expected extension contracts should include equivalents of:

```ts
interface Connector {
  readonly manifest: ConnectorManifest;
  test(context: ConnectorContext): Promise<ConnectionTestResult>;
  collect(
    context: ConnectorContext,
    previous?: SourceSnapshot,
  ): Promise<CollectionResult>;
}

interface WidgetDefinition<TConfig = unknown> {
  readonly manifest: WidgetManifest;
  validateConfig(config: unknown): TConfig;
  resolveData(
    config: TConfig,
    sources: SourceResolver,
  ): Promise<unknown>;
  render(props: WidgetRenderProps<TConfig>): React.ReactNode;
}

interface RenderBackend {
  render(request: RenderRequest): Promise<RenderedArtifact>;
}

interface DeviceAdapter {
  readonly protocol: string;
  resolveProfile(capabilities: DeviceCapabilityReport): DeviceProfile;
  buildDisplayResponse(
    device: Device,
    render: RenderedArtifact,
    request: DeviceRequest,
  ): Promise<DeviceDisplayResponse>;
}

interface ImageProcessor {
  process(
    input: Buffer,
    profile: DeviceProfile,
  ): Promise<ProcessedImage>;
}

interface WakeStrategy {
  supports(capabilities: DeviceCapabilities): boolean;
  calculateNextWake(
    policy: PowerPolicy,
    context: ScheduleContext,
  ): WakeDecision;
}
```

Adjust names and shapes when implementation evidence supports a cleaner design.

### 5.2 Separate refresh concepts

Model these independently:

1. Connector collection interval.
2. Dashboard render trigger.
3. Device polling interval.
4. Physical panel refresh policy.

Do not collapse these into one “refresh interval.”

The device should physically redraw only when the image changes, unless a forced full-refresh policy requires otherwise.

### 5.3 Immutable snapshots and revisions

Use immutable source snapshots and immutable dashboard revisions.

A source snapshot should include:

* Source and connector identifiers.
* Connector and output-schema versions.
* Observation and receipt timestamps.
* Fresh, stale, partial, or error state.
* Payload.
* Deterministic normalized payload hash.
* Optional validity deadline.
* Diagnostics and duration.
* Redacted errors or warnings.

A dashboard revision should include:

* Schema version.
* Complete declarative definition.
* Deterministic definition hash.
* Creation timestamp.
* Migration support.

Publication must be atomic.

### 5.4 Last-known-good chain

Preserve last-known-good state independently at each layer:

* Connector snapshot.
* Dashboard render.
* Device image.

A failure must not erase the prior successful result.

### 5.5 Exact preview parity

The browser editor preview and device renderer must use the same:

* React widget components.
* Render route.
* Stylesheets.
* Fonts.
* Resolved source data.
* Layout calculations.

Do not maintain separate preview-only and server-render-only implementations.

Create a canonical internal render route that both the editor iframe and browser screenshot worker consume.

Wait on a deterministic ready signal before capture.

Capture browser console errors, failed requests, missing assets, and timeouts in render diagnostics.

## 6. Repository organization

Prefer a structure similar to:

```text
apps/
  server/
  web/
  agent/
  render-worker/       # May remain integrated with server initially.

packages/
  contracts/
  domain/
  connector-sdk/
  connectors-built-in/
  widget-sdk/
  widgets-built-in/
  renderer/
  eink-processing/
  device-protocol/
  device-profiles/
  scheduling/
  testkit/

clients/
  kindle-kual/
  simulator/

prisma/
docker/
docs/
  adr/
  architecture/
  connector-development/
  widget-development/
  kindle/
```

Adapt this if extending an existing repository makes another organization materially cleaner.

Enforce package dependency boundaries through linting, TypeScript project references, or another automated check.

## 7. Connector system

Support three execution locations:

* `server`
* `agent`
* `webhook`

Implement a connector manifest containing:

* Stable ID and version.
* Display name and description.
* Execution location.
* Configuration JSON Schema.
* Secret-field metadata.
* Output schema version.
* Default and minimum collection interval.
* Timeout.
* Capability flags.

Automatically generate connector configuration forms from schemas.

Implement these generic connectors first:

1. HTTP JSON.
2. Webhook JSON.
3. Local command returning JSON.
4. JSON file.
5. CSV file.
6. RSS/Atom.
7. Static/manual data.

Then implement first-class adapters for:

* CodexBar.
* ActivityWatch.

Prefer wrapping generic connector primitives rather than duplicating transport, timeout, retry, validation, logging, hashing, and error behavior.

### 7.1 CodexBar

Support the most reliable available integration after inspecting the current CodexBar project:

* Local HTTP `/health`, `/usage`, and `/cost`, when available.
* JSON CLI fallback.

Never expose CodexBar directly to the public network.

Provide fixtures so development and tests work without an authenticated CodexBar installation.

### 7.2 ActivityWatch

Connect only through the local agent by default.

Provide useful normalized aggregates such as:

* Active screen time today.
* Top applications.
* Hourly activity.
* Coding time.
* Browser time.
* Productive versus distracting categories when configured.

Do not upload raw window titles by default.

Provide an explicit privacy setting for any potentially sensitive fields.

Include fixtures and tests that do not require ActivityWatch to be installed.

### 7.3 Safe transformations

Use JSONata or an equivalently constrained expression system.

Do not execute arbitrary JavaScript in the server process.

For command connectors:

* Do not use interpolated shell strings.
* Store executable and arguments separately.
* Enforce executable allowlists or explicit user authorization.
* Sanitize the environment.
* Limit execution time.
* Limit output size.
* Restrict working directories.
* Capture stdout and stderr separately.
* Never log secrets.

## 8. Widget system

Provide manifests and reusable contracts for widgets.

Initial widgets should include:

* Text.
* Metric.
* Progress bar.
* Gauge.
* Status indicator.
* List.
* Table.
* Bar chart.
* Line chart.
* Sparkline.
* Timeline or activity bars.
* Clock and date.
* Image.
* QR code.
* Conditional alert.
* Safe Liquid template widget.

Support optional canonical data contracts:

* Scalar.
* Metric.
* Status.
* List.
* Table.
* Time series.
* Image.

A generic progress widget must work with Codex usage, screen time, battery, storage, goals, or future numeric sources without connector-specific rendering code.

Every widget must handle:

* Missing data.
* Stale data.
* Partial data.
* Errors.
* Long text.
* Unicode.
* Small layouts.
* Monochrome output.
* Grayscale output.

## 9. Dashboard editor

Build a usable browser UI, not only APIs.

It must support:

* Creating, cloning, renaming, archiving, exporting, and importing dashboards.
* Dragging and resizing widgets.
* Editing widget configuration.
* Selecting a source and data expression.
* Exact device-resolution preview.
* Portrait and landscape.
* Device profile selection.
* Custom dimensions.
* Safe margins.
* Font scale.
* Contrast.
* Inversion.
* Palette and dithering.
* Previewing fresh, stale, missing, and error states.
* Publishing a revision.
* Viewing revision history.
* Assigning dashboards or playlists to devices.
* Manual render.
* Device refresh request where supported.

Keep the visual styling functional, clean, and e-ink-aware. Do not spend disproportionate effort on decorative animation.

## 10. Rendering and e-ink processing

Implement a deterministic render pipeline:

```text
resolved dashboard
→ canonical browser render route
→ exact-dimension screenshot
→ transparent-background flattening
→ crop/resize
→ grayscale
→ contrast/gamma
→ palette quantization
→ optional dithering
→ target image format
→ SHA-256
→ immutable artifact
```

Provide dithering strategies behind a common interface:

* None.
* Hard threshold.
* Bayer 2×2.
* Bayer 4×4.
* Floyd–Steinberg.
* Atkinson.

Support at least:

* 1-bit monochrome PNG.
* 4-level grayscale PNG.
* 16-level grayscale PNG.
* PGM where useful for Kindle compatibility.

Render fingerprints must include:

* Dashboard revision hash.
* Referenced source snapshot hashes.
* Device-profile hash.
* Renderer version.
* Font and asset version.
* Relevant time bucket for clock-dependent widgets.

Reuse a successful render when the complete fingerprint already exists.

Do not rerender unrelated dashboards when one source changes.

Maintain a dependency index from sources to dashboards and dashboards to assigned devices.

Debounce bursts of source changes.

## 11. Device and screen profiles

A device profile must support:

* Width and height.
* Orientation.
* Safe area.
* Palette.
* Output format.
* Dithering strategy.
* Contrast and gamma.
* Full-refresh interval.
* Partial-refresh capability.
* Touch capability.
* Wi-Fi control capability.
* Keep-awake capability.
* Scheduled-wake capability.
* User overrides.

The user must be able to select:

* Auto-detected profile.
* Known model.
* Custom dimensions.
* Portrait or landscape.
* Rotation.
* Safe margins.
* Font scaling.
* Dithering.
* Contrast.
* Inversion.

Never hardcode the product to one Kindle resolution.

## 12. Device delivery protocol

Prefer a simple direct-image endpoint:

```http
GET /api/v1/device/display
Authorization: Bearer <device-token>
If-None-Match: "<current-etag>"
```

Changed output:

```http
200 OK
Content-Type: image/png
ETag: "<image-hash>"
X-Next-Poll-Seconds: 300
X-Render-ID: "<render-id>"
X-Image-SHA256: "<hash>"
X-Full-Refresh: false
```

Unchanged output:

```http
304 Not Modified
ETag: "<image-hash>"
X-Next-Poll-Seconds: 300
```

Use immutable render artifacts and atomic publication.

Device tokens must:

* Have high entropy.
* Be individually revocable.
* Be stored hashed server-side.
* Have no control-plane privileges.

Add device enrollment and token rotation.

## 13. Kindle client

Create a clean Kindle KUAL client without copying unlicensed source.

The client must:

* Be installable as a KUAL extension.
* Support configuration and enrollment.
* Detect available framebuffer/display tools.
* Detect screen dimensions where possible.
* Fetch the display endpoint.
* Send `If-None-Match`.
* Read `X-Next-Poll-Seconds`.
* Download into a temporary file.
* Validate content type, dimensions, image signature, size, and SHA-256.
* Atomically promote valid downloads.
* Preserve current and previous images.
* Display through the safest available mechanism.
* Use `eips` first where practical.
* Use a minimal native framebuffer helper only when necessary.
* Log useful diagnostics.
* Apply bounded exponential backoff.
* Keep the previous screen during server or network failure.
* Avoid reboot loops.
* Restore normal power behavior when stopped.

Provide KUAL actions for at least:

* Start.
* Stop.
* Refresh once.
* Show status.
* Re-enroll or update configuration.
* Restore normal sleep behavior.
* View or export diagnostics.

Support power modes:

* Always on.
* Smart sleep.
* Scheduled.
* Manual.

Treat scheduled wake as capability-gated and firmware-sensitive. Fall back safely when unsupported.

## 14. Scheduling and power behavior

Implement:

* Independent source collection intervals.
* Device polling intervals.
* Manual-only mode.
* Quiet hours.
* Timezone selection.
* Optional sleep screen.
* Freeze-current behavior.
* Playlist transitions.
* Dashboard schedules.
* Failure backoff.
* Poll jitter.
* Minimum and maximum safe polling limits.

Calculate the next useful poll using the minimum relevant boundary among:

* User maximum interval.
* Next playlist transition.
* Next clock-widget change.
* Quiet-hour boundary.
* Scheduled dashboard change.
* Source validity expiry.

Do not rely on the Kindle’s clock for server-side business decisions.

## 15. Persistence

Use a clear persistence model covering at least:

* Users or local administrator identity.
* Devices.
* Device tokens.
* Device profiles.
* Dashboards.
* Dashboard revisions.
* Device assignments.
* Playlists.
* Playlist entries.
* Schedules.
* Connector manifests.
* Connector instances.
* Connector secrets.
* Source snapshots.
* Source health.
* Render jobs.
* Render artifacts.
* Device check-ins.
* Audit events.

Store secrets separately from regular JSON configuration.

Use application-level encryption for server-side connector secrets with a master key outside the database.

Use macOS Keychain for agent-local secrets when feasible.

Add migrations, seed data, export, import, backup, and restore commands.

Test backup and restore automatically.

## 16. Durable jobs

Do not require Redis initially.

Implement a SQLite-backed durable job queue or use a mature SQLite-compatible library after evaluating it.

Jobs must survive restart and support:

* Pending.
* Running.
* Succeeded.
* Failed.
* Retry count.
* Run-after timestamp.
* Lease owner and expiry.
* Timeout.
* Deduplication key.

Required job types include:

* Connector collection.
* Dashboard rendering.
* Artifact cleanup.
* Snapshot cleanup.
* Optional scheduled device reassignment.

Recover abandoned leases after crashes.

## 17. Security

Implement and test:

* Outbound-only local agent.
* No public exposure of ActivityWatch or CodexBar.
* SSRF protection on server HTTP connectors.
* Default denial of loopback, link-local, metadata-service, and private-network targets from server connectors.
* Explicit opt-in for private-network access.
* No arbitrary server-side JavaScript.
* Strict command connector controls.
* Request and response size limits.
* Connector and render timeouts.
* Content Security Policy on render routes.
* Allowed remote-asset policy.
* Secret redaction.
* Authentication and authorization.
* CSRF protection where applicable.
* Rate limiting.
* Device-token scope isolation.
* Audit logging.
* Secure headers.
* Dependency and container vulnerability scanning.
* License inventory and notices.

Provide a concise threat model under `docs/security/`.

## 18. Observability and diagnostics

Provide:

* Structured logs.
* Correlation IDs.
* Connector health.
* Last successful collection time.
* Snapshot age.
* Render duration.
* Render errors.
* Browser console errors.
* Device last-seen time.
* Current assigned dashboard.
* Device firmware/client/profile information.
* Last successful image download.
* Poll interval.
* Consecutive failures.
* Database and renderer health endpoints.

Expose a usable system diagnostics page.

Never emit secrets or raw sensitive ActivityWatch content into logs.

## 19. Testing requirements

Testing is a product requirement.

### 19.1 Unit tests

Cover:

* Hash normalization.
* JSONata evaluation.
* Schema validation.
* Scheduling.
* Quiet hours crossing midnight.
* Poll calculations.
* Retry and backoff.
* ETag behavior.
* Device-profile resolution.
* Image validation.
* Dithering.
* Job leasing and recovery.
* Secret redaction.
* SSRF protections.

### 19.2 Shared connector contract suite

Every connector must pass reusable tests for:

* Valid manifest.
* Valid configuration.
* Successful collection.
* Timeout behavior.
* Cancellation.
* Output envelope.
* Output-size limits.
* Stable hashing.
* Error mapping.
* Secret redaction.
* Retry policy.

### 19.3 Shared widget contract suite

Every widget must be tested with:

* Valid data.
* Missing data.
* Partial data.
* Stale data.
* Error state.
* Long values.
* Unicode.
* Minimum supported size.
* Monochrome profile.
* Grayscale profile.

### 19.4 Golden-image tests

For representative dashboards and device profiles:

* Render the dashboard.
* Process it to the target palette.
* Compare against approved golden images.
* Use a controlled tolerance where anti-aliasing differences are unavoidable.
* Store or generate useful diff images on failure.

### 19.5 Device simulator

Build a virtual Kindle/device client that supports:

* Enrollment.
* Display fetch.
* ETag.
* 200 and 304 behavior.
* Invalid token.
* Wrong content type.
* Wrong hash.
* Truncated download.
* Offline server.
* Backoff.
* Quiet hours.
* Dashboard reassignment.
* Custom dimensions.
* Client capability reporting.

### 19.6 End-to-end tests

At minimum:

```text
fixture connector emits known value
→ snapshot stored
→ dashboard dependency detected
→ render job executed
→ browser route rendered
→ e-ink image generated
→ device endpoint returns image
→ simulator validates and stores image
→ pixel/text assertion proves the value is present
```

Also test:

* CodexBar fixture dashboard.
* ActivityWatch fixture dashboard.
* Dashboard edit and publication.
* Device assignment.
* Unchanged image returns 304.
* Connector failure retains last-known-good render.
* Render failure retains prior device image.
* Backup and restore.

## 20. CI and quality gates

Set up GitHub Actions or equivalent local CI configuration for:

* Formatting.
* Linting.
* Type checking.
* Unit tests.
* Contract tests.
* Integration tests.
* End-to-end tests.
* Golden-image tests.
* Production builds.
* Docker image build.
* Migration verification.
* Dependency audit.
* Secret scanning.
* License scanning.
* Container health smoke test.

Pin runtime and package-manager versions.

Use lockfiles.

Avoid floating Docker image tags.

Generate test reports and screenshot diffs as CI artifacts.

## 21. Developer experience

Provide commands comparable to:

```bash
pnpm install
pnpm dev
pnpm test
pnpm test:e2e
pnpm test:golden
pnpm lint
pnpm typecheck
pnpm build
pnpm docker:up
pnpm docker:down
pnpm seed
pnpm backup
pnpm restore
pnpm agent:dev
pnpm simulator
```

A new developer should be able to get a fixture-backed system running without external credentials.

Provide:

* `.env.example`
* Seeded sample data
* CodexBar fixtures
* ActivityWatch fixtures
* Sample dashboards
* Sample device profiles
* Sample playlist
* Local development login or secure single-user bootstrap
* Clear reset command

## 22. Deployment

Produce:

* Production Dockerfile.
* Docker Compose configuration.
* Persistent volume configuration.
* Health checks.
* Safe startup migrations.
* Backup procedure.
* Restore procedure.
* Upgrade procedure.
* Rollback procedure.
* `.env.example`.
* Reverse-proxy guidance.
* HTTPS guidance.
* macOS agent packaging or install script.
* `launchd` plist and install/uninstall commands for the agent.
* Kindle KUAL installable archive or reproducible packaging command.

The default deployment should require the fewest reasonable moving parts.

## 23. Documentation deliverables

Create:

* `README.md` with immediate setup.
* `docs/architecture/overview.md`
* `docs/architecture/data-flow.md`
* `docs/architecture/rendering.md`
* `docs/architecture/device-protocol.md`
* `docs/architecture/power-and-refresh.md`
* `docs/connector-development/README.md`
* `docs/widget-development/README.md`
* `docs/kindle/install.md`
* `docs/kindle/troubleshooting.md`
* `docs/security/threat-model.md`
* `docs/deployment.md`
* `docs/backup-and-restore.md`
* `docs/testing.md`
* ADRs for major choices.
* License and third-party notices.
* OpenAPI documentation or generated API reference.

Document why the four refresh concepts are separate.

Document known Kindle firmware/hardware risks without presenting untested assumptions as facts.

## 24. Initial sample dashboards

Include polished fixture-backed dashboards demonstrating:

### Work dashboard

* Codex current-window usage.
* Codex weekly usage.
* Reset time.
* ActivityWatch active time.
* Top applications.
* Hourly activity bars.
* Current date and time.
* Source freshness.

### System dashboard

* Server health.
* Agent health.
* Last render.
* Device last seen.
* Connector status.
* Database size.
* Current dashboard assignment.

### Minimal dashboard

* Large clock.
* Date.
* One metric.
* One alert.
* Designed for high readability and low refresh frequency.

## 25. Scope control

Do not block the stable core on:

* Touch interactions.
* Arbitrary third-party npm execution.
* Plugin marketplace.
* Multiple server instances.
* Kubernetes.
* Public SaaS billing.
* AI-generated layouts.
* Universal scheduled wake across all Kindle firmware.
* Partial-refresh optimization for every model.

Build clean extension seams for these, but do not sacrifice the working core.

Touch support may be added only after the passive display path and tests are stable.

## 26. Required execution workflow

Follow this loop:

1. Inspect the current repository and environment.
2. Research upstream projects and licenses.
3. Record the selected foundation and major ADRs.
4. Establish baseline builds and tests before large refactoring.
5. Implement vertical slices rather than disconnected layers.
6. Run formatting, linting, type checking, tests, and builds frequently.
7. Start the application locally.
8. Exercise real API and UI flows.
9. Capture screenshots of the working UI and generated e-ink outputs.
10. Use the simulator to validate the full device protocol.
11. Build the production container.
12. Start the production container and run smoke tests.
13. Package the agent and Kindle extension.
14. Review security, licensing, migrations, backup, and restore.
15. Remove dead code, duplicated paths, debug shortcuts, and stale TODOs.
16. Update documentation to match the actual implementation.
17. Run the complete quality gate again.
18. Continue fixing until all achievable checks pass.

Do not mark a test skipped merely because it is inconvenient. Use a simulator or fixture.

Do not leave generated mock implementations in production paths unless they are explicitly development-only.

## 27. Definition of done

The project is complete only when all of the following are true:

* A fixture-backed local installation starts with documented commands.
* The browser control plane is usable.
* A dashboard can be created or edited.
* A dashboard can be previewed at a selected device resolution.
* CodexBar fixture data renders.
* ActivityWatch fixture data renders.
* A custom HTTP or webhook source renders.
* A dashboard revision can be published.
* A device can be enrolled or simulated.
* A dashboard can be assigned to that device.
* The device endpoint returns an image.
* ETag causes unchanged requests to return 304.
* The simulator validates and stores the image.
* A changed snapshot produces a changed render.
* Connector failure preserves the last-known-good output.
* Render failure preserves the last-known-good device image.
* Quiet hours and polling policies work in tests.
* Custom dimensions work.
* At least monochrome and grayscale profiles work.
* Production builds pass.
* The production Docker container starts and passes health checks.
* Database migrations work from a clean database.
* Backup and restore are tested.
* CI configuration is present.
* Security and licensing documentation is present.
* The agent can run with fixtures and has a macOS installation path.
* The Kindle extension is packaged reproducibly.
* Hardware-only validation steps are clearly documented.

## 28. Final response format

At the end, provide a concise implementation report containing:

1. What was built.
2. The selected foundation and why.
3. Exact commands to start it.
4. Local URLs and test credentials, if applicable.
5. Test, lint, type-check, build, migration, container, and smoke-test results.
6. Generated screenshots and e-ink sample paths.
7. Kindle package path.
8. macOS agent package or installation path.
9. Major architectural decisions.
10. Security and licensing notes.
11. Anything that could only be validated on physical Kindle hardware.
12. The next highest-value improvements, limited to genuinely unfinished optional work.

Do not end with a proposal to implement the system later. Implement it now within the available environment.
