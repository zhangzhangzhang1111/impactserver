# Impactserver MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 1 Node.js service for submitting analysis tasks, tracking status, producing local JSON/Markdown reports, and preparing GitHub release assets for offline analysis tools.

**Architecture:** The MVP uses Node.js built-ins for an HTTP API, local JSON task metadata, Git diff collection, heuristic symbol/rule analysis, and report rendering. Heavy analyzers such as Tree-sitter grammars, LSP servers, and static tools are represented by a GitHub release manifest plus downloader so Linux/offline deployments can stage the release artifacts.

**Tech Stack:** Node.js 20, `node:http`, `node:test`, local filesystem storage, Git CLI, GitHub releases API.

---

### Task 1: Service Skeleton

**Files:**
- Create: `package.json`
- Create: `src/server.js`
- Create: `src/app.js`
- Create: `src/config.js`
- Create: `src/http.js`
- Test: `test/http.test.js`

- [x] Write HTTP helper and router tests first.
- [x] Implement JSON parsing, auth hook, health route, task routes, and server entrypoint.
- [x] Run `npm test`.

### Task 2: Task Store And Analysis Pipeline

**Files:**
- Create: `src/task-store.js`
- Create: `src/task-service.js`
- Create: `src/analyzer.js`
- Create: `src/git-diff.js`
- Create: `src/diff-parser.js`
- Test: `test/pipeline.test.js`

- [x] Write tests for task creation, idempotency, diff parsing, and report generation.
- [x] Implement local metadata storage under `runtime/tasks`.
- [x] Implement async task state transitions and local Git diff collection.
- [x] Run `npm test`.

### Task 3: Symbols, Rules, And Reports

**Files:**
- Create: `src/language.js`
- Create: `src/symbol-locator.js`
- Create: `src/rule-engine.js`
- Create: `src/report-renderer.js`
- Test: `test/pipeline.test.js`

- [x] Write tests for Python/Lua symbol mapping and redline findings.
- [x] Implement language detection and heuristic symbol locators for Lua, C/C++, Java, and Python.
- [x] Implement deterministic redline and language-specific rule checks.
- [x] Render `report.json`, `review.md`, `diff.patch`, `ai-usage.json`, and `static-findings.json`.
- [x] Run `npm test`.

### Task 4: Offline GitHub Release Resources

**Files:**
- Create: `config/offline-resources.json`
- Create: `scripts/download-offline-resources.js`
- Create: `src/offline-resources.js`
- Test: `test/offline-resources.test.js`

- [x] Write tests for release asset selection.
- [x] Implement latest-release JSON parsing and asset selection by regular expression.
- [x] Add open-source GitHub release entries for clangd, LuaLS, Pyright, Eclipse JDT LS helper metadata, and Tree-sitter grammars.
- [x] Run `npm test`.

### Task 5: Documentation And Verification

**Files:**
- Modify: `README.md`

- [x] Document API usage, local path analysis mode, report paths, and offline download command.
- [x] Run `npm test`.
- [x] Run a smoke API request against the Node server.
