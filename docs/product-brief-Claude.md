# Product brief: API Health Monitor

Status: portfolio build, v1.0.0, November 2026. Statements below are design intent unless marked as measured.

1. **What it is.** A self-hosted API health monitor: a REST API plus dashboard that stores endpoint monitors, runs scheduled HTTP checks with assertions, charts latency by connection phase, opens incidents after repeated failures, and logs unexpected responses with a bounded sample.
2. **Who it is for.** Backend and platform engineers who own a handful to a few hundred HTTP dependencies and want checks they control (in their network, their database, their retention rules) rather than a SaaS seat per monitor. Secondary audience: hiring managers and clients evaluating REST API design work.
3. **Why it wins for that user.** Zero runtime dependencies and one SQLite file make it auditable in an afternoon. Phase-level timings (DNS, TCP, TLS, TTFB, transfer) separate "the network is slow" from "the server is slow". The `degraded` outcome keeps slow-but-correct responses out of incident noise. The API is the product: every UI action is a documented REST call with ETags, idempotency keys and problem details.
4. **Structure.** `/v1` resources (monitors, state, checks, stats, incidents, overview, events, openapi.json); dashboard views for Overview, Monitor detail, Incidents and API reference. The static snapshot mirrors the API paths as JSON files.
5. **Discovery.** GitHub repository (topics, social preview, README screenshots), the live GitHub Pages snapshot, and a technical article on the design decisions (draft offered, not written).
6. **Engagement.** Users land on the live snapshot, open a monitor, read the unexpected-response log and the recorded HTTP transcripts, then clone and run `npm run demo`.
7. **Conversion.** For the portfolio goal: a recruiter or client moves from the live page to the repository and from the README to the code and tests. For a self-hoster: `npm run demo` to a first custom monitor.
8. **Revenue.** None directly (MIT). The plausible commercial paths are a hosted multi-probe version (checks from several regions, per-team auth) and consulting on API design and reliability reviews. Neither is built.
9. **Launch.** Push repository, enable Pages via the workflow, confirm the first scheduled run publishes `gh-actions` checks, set topics and homepage, upload the social preview, then publish the article.
10. **After launch.** Measure from GitHub traffic insights (views, unique visitors, clones, referrers) since the site carries no analytics by design. Product next steps in order: lease-based scheduling for multiple replicas, an async `202 Accepted` run-now, webhook/Slack notifications on incident events, and multi-probe aggregation.

## KPIs (declared before launch)

| KPI | Source | Decision it informs |
| --- | --- | --- |
| Repository unique visitors per week | GitHub traffic insights | Whether the article and profile links are driving discovery |
| Clones per week | GitHub traffic insights | Whether visitors go past reading to running it |
| Scheduled snapshot success rate | Actions run history | Whether the live page is trustworthy enough to keep linking |

No GA4 events: the site intentionally sets no cookies and loads no third-party scripts. If analytics are added later, use the canonical `content_engagement_click` and `self_serve_cta_click` events from the estate event dictionary rather than new names.

## Definition of done: status by dimension

| Dimension | Status |
| --- | --- |
| Product intent, ICP, UX flow | Met for v1; error paths shown in forms (field-level 422 mapping) and toasts (412, 429) |
| Frontend / backend architecture, data model | Met; see README Architecture |
| Security | SSRF guard, auth model, CSP, redaction; independent review run before publish |
| Privacy | No personal data collected; no cookies; demo stores status and timing only |
| QA | 27 automated tests; manual browser pass of each view |
| Deployment | CI on Node 22 and 24; Pages workflow with pinned actions |
| Observability | Structured JSON request logs with request IDs; `/v1/health` |
| Analytics | Not instrumented by design (see above) |
| CRO | Live page links to source and to `npm run demo` instructions |
| Maintainability | No dependencies to update; OpenAPI drift test; decisions documented inline |
