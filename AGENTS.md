# Repository Guidelines

## Project Structure & Module Organization
- Service code lives in `src/`.
- Static or sample payloads live in `test-data/`.
- Project metadata and scripts live in `package.json`; Fastly service configuration lives in `fastly.toml`.
- Keep request handling, signature verification, and KV-update logic separated where practical instead of growing a single large module.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run build`: compile the Fastly Compute package.
- `npm run dev`: serve the service locally through Fastly Compute.
- `npm run deploy`: publish the service to Fastly.
- Use the local curl examples in `README.md` to manually verify endpoint behavior when changing webhook handling.

## Coding Style & Naming Conventions
- Use modern JavaScript modules and keep payload and response shapes explicit.
- Prefer focused helpers and clear edge-case handling over broad shared utility buckets.
- Keep PRs tightly scoped. Do not mix unrelated cleanup, formatting churn, or speculative refactors into the same change.
- Temporary or transitional code must include `TODO(#issue):` with the tracking issue for removal.

## Pull Request Guardrails
- PR titles must use Conventional Commit format: `type(scope): summary` or `type: summary`.
- Set the correct PR title when opening the PR. Do not rely on fixing it afterward.
- If a PR title changes after opening, verify that the semantic PR title check reruns successfully.
- PR descriptions must include a short summary, motivation, linked issue, and manual test plan.
- Changes to webhook validation, KV writes, or public endpoints should include representative payloads or request examples when helpful.

## Security & Sensitive Information
- Do not commit secrets, webhook shared secrets, private payload samples, or sensitive customer data.
- Public issues, PRs, branch names, screenshots, and descriptions must not mention corporate partners, customers, brands, campaign names, or other sensitive external identities unless a maintainer explicitly approves it. Use generic descriptors instead.
