# impactserver

Node.js MVP for the AI code impact analysis and review system described in
`ai_code_impact_analysis_design.md`.

## What is implemented

- `POST /api/v1/analysis/tasks` creates an analysis task and returns `task_id`.
- `GET /api/v1/analysis/tasks/{task_id}` returns local task metadata and status.
- `GET /api/v1/analysis/tasks/{task_id}/report?format=json|markdown` returns the generated report.
- `GET /dashboard` opens the built-in progress dashboard for recent analysis tasks and report links.
- `GET /api/v1/dashboard` returns dashboard data for worker state, task progress, and report availability.
- Local task metadata is stored in `runtime/tasks`.
- Reports are written under `reports/{project}/{date}/{branch-time-task}/`.
- Structured JSON logs are emitted for service startup, task lifecycle events, analysis stages, cleanup, and exceptions.
- Git diff input can come from either `diff_patch` in the request or a local repository path plus `base_commit` / `target_commit`.
- The MVP includes configurable Tree-sitter wrapper symbol location with heuristic fallback, deterministic redline checks, and built-in language pitfall rules for Lua, C/C++, Java, and Python.
- Impact trees include changed symbols plus Level 1 / Level 2 callers found through static reference tracing when repository sources are available.
- Configured LSP call hierarchy wrappers can override static-reference impact data and mark impact entries as `source: "LSP"`.
- Offline tool resources are described in `config/offline-resources.json` and resolved/downloaded from open-source GitHub releases.

## Run

```bash
npm test
npm start
npm run webhook:client
```

Optional environment variables:

```bash
IMPACT_HOST=127.0.0.1
IMPACT_PORT=3000
IMPACT_API_TOKEN=
IMPACT_RUNTIME_DIR=runtime
IMPACT_REPORTS_DIR=reports
IMPACT_LOG_LEVEL=info
IMPACT_LOG_DIR=runtime/logs
IMPACT_LOG_TO_FILE=false
IMPACT_WORKSPACE_DIR=workspaces
IMPACT_GIT_CACHE_DIR=git-cache
IMPACT_ALLOWED_CLONE_URL_PATTERNS=
IMPACT_PROJECT_CONFIG=config/projects.json
IMPACT_RETAIN_WORKSPACES=false
IMPACT_REPORT_RETENTION_DAYS=30
IMPACT_PROTECTED_BRANCH_RETENTION_DAYS=180
IMPACT_AUTO_RUN_TASKS=true
IMPACT_WORKER_CONCURRENCY=1
IMPACT_TASK_TIMEOUT_MS=0
IMPACT_AI_ENABLED=false
IMPACT_AI_PROVIDER=
IMPACT_AI_BASE_URL=
IMPACT_AI_API_KEY=
IMPACT_AI_MODEL=default
IMPACT_AI_TIMEOUT_MS=60000
IMPACT_AI_MAX_RETRIES=2
IMPACT_AI_MAX_OUTPUT_TOKENS=0
IMPACT_AI_ANTHROPIC_VERSION=2023-06-01
```

If `IMPACT_API_TOKEN` is set, API callers must send:

```text
Authorization: Bearer <token>
```

The dashboard HTML shell at `/dashboard` can still be opened directly in a browser. Its data requests remain protected; when `IMPACT_API_TOKEN` is configured, the page prompts for the token and sends it as a Bearer token.

## Webhook test client

The core backend stays platform-neutral. A separate Node.js webhook client can receive GitHub or GitLab events, verify the platform signature, convert the payload to the unified analysis request, and forward it to the backend:

```bash
IMPACT_API_URL=http://127.0.0.1:3000 \
IMPACT_API_TOKEN=backend-token \
IMPACT_WEBHOOK_SECRET=webhook-secret \
IMPACT_DEFAULT_LANGUAGES=lua,cpp,java,python \
npm run webhook:client
```

Client environment variables:

```bash
IMPACT_WEBHOOK_HOST=127.0.0.1
IMPACT_WEBHOOK_PORT=3005
IMPACT_WEBHOOK_SECRET=
IMPACT_API_URL=http://127.0.0.1:3000
IMPACT_API_TOKEN=
IMPACT_DEFAULT_LANGUAGES=lua,cpp,java,python
```

Webhook endpoints:

```text
POST /webhooks/github
POST /webhooks/gitlab
GET  /healthz
```

GitHub requests are accepted for `pull_request` actions `opened`, `synchronize`, and `reopened`; signatures use `X-Hub-Signature-256`. GitLab requests are accepted for merge request actions `open`, `update`, and `reopen`; token validation uses `X-Gitlab-Token`. Unsupported events return `202` with an ignored reason instead of creating an analysis task.

## Project configuration

The backend can load project defaults from `config/projects.json` or the path set by `IMPACT_PROJECT_CONFIG`. Use [config/projects.example.json](/Users/xilong/Documents/codegit/impactserver/config/projects.example.json) as a starting point:

```json
{
  "projects": [
    {
      "name": "user-service",
      "repository_full_name": "org/user-service",
      "clone_url": "https://github.com/org/user-service.git",
      "default_branch": "main",
      "credential_ref": "github-readonly-key",
      "languages": ["python", "java"],
      "options": {
        "max_call_depth": 2,
        "enable_ai_review": true
      },
      "ai": {
        "max_input_tokens": 120000
      },
      "rules": {
        "custom_rules": [
          {
            "id": "PROJECT-PY-ANNOTATION",
            "language": "python",
            "severity": "WARNING",
            "category": "Style",
            "description": "Project service functions should expose type annotations.",
            "pattern": "^def service_[^(]+\\([^)]*\\):",
            "suggestion": "Add explicit argument and return type annotations."
          }
        ]
      },
      "retention_days": 30,
      "protected_branch_retention_days": 180
    }
  ]
}
```

Task requests are merged with project defaults by `project.name`. Explicit request fields win over defaults; missing repository metadata, languages, options, AI settings, project-level custom review rules, static tool configuration, and retention days come from the project config.

Project-level `rules.custom_rules` use the same regex rule shape as repository review config, but findings and AI context cite them as `project:config#RULE_ID` with `source_engine: ["project-custom-rule"]`.

Query public, redacted project defaults:

```bash
curl -sS http://127.0.0.1:3000/api/v1/projects
curl -sS http://127.0.0.1:3000/api/v1/projects/user-service/config
```

## Submit a task with inline diff

```bash
curl -sS http://127.0.0.1:3000/api/v1/analysis/tasks \
  -H 'content-type: application/json' \
  -d '{
    "project": { "name": "demo-service" },
    "revision": {
      "source_branch": "feature/sql-risk",
      "target_branch": "main"
    },
    "trigger": {
      "provider": "github",
      "delivery_id": "local-demo-1",
      "pr_number": 7
    },
    "languages": ["python"],
    "diff_patch": "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,3 @@\n def get_user(name):\n+    sql = f\"select * from users where name = '\''{name}'\''\"\n     return None\n"
  }'
```

## Submit a task for Git repositories

Use `project.repository_path` or a `file://` clone URL for local repositories:

```json
{
  "project": {
    "name": "user-service",
    "repository_path": "/path/to/user-service"
  },
  "revision": {
    "base_commit": "BASE_SHA",
    "target_commit": "HEAD_SHA",
    "source_branch": "feature/example"
  },
  "languages": ["lua", "cpp", "java", "python"]
}
```

The service runs:

```bash
git -C /path/to/user-service worktree add --detach <workspace> HEAD_SHA
git -C <workspace> diff --unified=80 BASE_SHA HEAD_SHA
```

For remote repositories, provide `project.clone_url`. The service keeps a bare mirror cache under `IMPACT_GIT_CACHE_DIR`, runs `git remote update --prune` for repeated analyses, and creates an isolated worktree at `revision.target_commit`.

Set `IMPACT_ALLOWED_CLONE_URL_PATTERNS` to a comma-separated list of JavaScript regular expressions to restrict remote clone targets, for example `^https://github\\.com/org/,^git@github\\.com:org/`. When configured, both `project.clone_url` and fork pull request `revision.source_repo.clone_url` must match the allowlist before any `git clone` or `git fetch` command runs.

For fork pull requests, set `revision.source_repo.clone_url`; the mirror cache fetches `revision.target_commit` from that source repository before creating the worktree.

The checked-out worktree is used for symbol location so changed files are read from the target revision, then removed after report generation. Set `IMPACT_RETAIN_WORKSPACES=true` when debugging an analysis task.

## Task history and cleanup

List recent tasks:

```bash
curl -sS 'http://127.0.0.1:3000/api/v1/analysis/tasks?project=demo-service&limit=50'
```

Cancel a task that is still pending in the worker queue:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/analysis/tasks/task_20260603_000001/cancel
```

Inspect the in-process worker queue:

```bash
curl -sS http://127.0.0.1:3000/api/v1/worker/stats
```

Open the progress dashboard:

```text
http://127.0.0.1:3000/dashboard
```

Query dashboard data:

```bash
curl -sS 'http://127.0.0.1:3000/api/v1/dashboard?limit=50'
```

Report directories contain both human and machine-readable artifacts:

```text
index.html
review.md
report.json
diff.patch
ai-usage.json
static-findings.json
tree-sitter-tool-runs.json
static-tool-runs.json
lsp-tool-runs.json
artifacts.json
```

Open `index.html` for a local visual overview. Use `artifacts.json` as the stable manifest when archiving or syncing report files.

Fetch report artifacts through the API by role:

```bash
curl -sS http://127.0.0.1:3000/api/v1/analysis/tasks/task_20260603_000001/artifacts/html_report
curl -sS http://127.0.0.1:3000/api/v1/analysis/tasks/task_20260603_000001/artifacts/artifact_manifest
```

Clean expired local task metadata and report directories:

```bash
curl -sS http://127.0.0.1:3000/api/v1/maintenance/cleanup \
  -H 'content-type: application/json' \
  -d '{"dry_run": true}'
```

Reports on ordinary branches use `IMPACT_REPORT_RETENTION_DAYS` (default 30). `main`, `master`, and `release/*` or `release-*` branches use `IMPACT_PROTECTED_BRANCH_RETENTION_DAYS` (default 180).

`IMPACT_WORKER_CONCURRENCY` controls how many analyses run at once in the Node.js worker. `IMPACT_TASK_TIMEOUT_MS=0` disables analysis timeout; a positive value marks long-running tasks as `TIMEOUT`.

## Offline resources

Resolve GitHub latest releases without downloading large files:

```bash
npm run offline:download -- config/offline-resources.json offline-resources --dry-run
```

Download the selected release artifacts:

```bash
npm run offline:download -- config/offline-resources.json offline-resources
```

Set `GITHUB_TOKEN` when anonymous GitHub API access is rate-limited:

```bash
GITHUB_TOKEN=ghp_xxx npm run offline:download -- config/offline-resources.json offline-resources
```

The downloader writes `offline-resources/offline-resources.lock.json`, including resolved release tags, asset URLs, local paths, digests when GitHub provides them, computed `sha256`, verification status, cache hits, and source archive URLs for projects that publish source archives instead of binary release assets.

Downloaded files are verified by size and `sha256:` digest when GitHub exposes one. Re-running the command reuses a local file when verification passes, so staged offline resources are stable across repeated setup runs.

Current manifest coverage:

- `clangd` for C/C++ LSP binaries.
- `lua-language-server` for Lua LSP binaries.
- `pyright` GitHub source archive metadata for Python LSP/static analysis packaging.
- `eclipse-jdt-ls` GitHub release metadata for Java LSP traceability.
- `tree-sitter-cli` Linux x64 release artifact for offline parser tooling.
- Tree-sitter grammar source archives for Python, Lua, C++, and Java.

## Current MVP limitations

- Tree-sitter symbol location is imported through configured wrapper commands; if no wrapper is configured or a wrapper fails, the task falls back to heuristic symbol parsing.
- Native JSON-RPC LSP sessions are not managed directly yet; LSP call hierarchy is imported through configured wrapper commands.
- AI review supports provider-specific official request shapes for OpenAI Chat Completions, Anthropic Messages, Gemini GenerateContent, DeepSeek, Qwen, Doubao, MiniMax, and custom OpenAI-compatible `/chat/completions` providers. It includes JSON finding parsing, 429/5xx retry, timeout control, context token estimation, chunking, and one repair prompt for invalid JSON output.

## AI review

Enable AI review globally with environment variables:

```bash
IMPACT_AI_ENABLED=true \
IMPACT_AI_PROVIDER=qwen \
IMPACT_AI_API_KEY=secret \
IMPACT_AI_MODEL=qwen-plus \
npm start
```

Supported provider values:

| Provider | Official request shape | Default endpoint |
| --- | --- | --- |
| `openai` | Chat Completions with `messages`, `response_format`, and `max_completion_tokens` | `https://api.openai.com/v1/chat/completions` |
| `anthropic` | Messages API with top-level `system`, user/assistant `messages`, and `max_tokens` | `https://api.anthropic.com/v1/messages` |
| `gemini` | GenerateContent with `contents[].parts[]` and `generationConfig` | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |
| `deepseek` | DeepSeek official OpenAI ChatCompletions-compatible API | `https://api.deepseek.com/chat/completions` |
| `qwen` | Alibaba Cloud Model Studio DashScope OpenAI-compatible API | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |
| `doubao` | Volcengine Ark OpenAI SDK-compatible API | `https://ark.cn-beijing.volces.com/api/v3/chat/completions` |
| `minimax` | MiniMax official text chat completion API | `https://api.minimax.io/v1/text/chatcompletion_v2` |
| `openai-compatible` | Custom OpenAI-compatible Chat Completions gateway | Set `IMPACT_AI_BASE_URL` |
 
Examples:

```bash
# OpenAI
IMPACT_AI_ENABLED=true IMPACT_AI_PROVIDER=openai IMPACT_AI_API_KEY=sk-... IMPACT_AI_MODEL=gpt-5.1 npm start

# DeepSeek
IMPACT_AI_ENABLED=true IMPACT_AI_PROVIDER=deepseek IMPACT_AI_API_KEY=... IMPACT_AI_MODEL=deepseek-v4-flash npm start

# 通义千问 / DashScope 百炼
IMPACT_AI_ENABLED=true IMPACT_AI_PROVIDER=qwen IMPACT_AI_API_KEY=... IMPACT_AI_MODEL=qwen-plus npm start

# 豆包 / 火山方舟
IMPACT_AI_ENABLED=true IMPACT_AI_PROVIDER=doubao IMPACT_AI_API_KEY=... IMPACT_AI_MODEL=doubao-pro-32k-240615 npm start

# MiniMax
IMPACT_AI_ENABLED=true IMPACT_AI_PROVIDER=minimax IMPACT_AI_API_KEY=... IMPACT_AI_MODEL=MiniMax-M2.5 npm start

# Custom OpenAI-compatible gateway
IMPACT_AI_ENABLED=true IMPACT_AI_PROVIDER=openai-compatible IMPACT_AI_BASE_URL=https://ai-gateway.example.com/v1 IMPACT_AI_API_KEY=... IMPACT_AI_MODEL=qwen-coder npm start
```

The request can still disable AI per task:

```json
{
  "options": {
    "enable_ai_review": false
  }
}
```

AI input chunks include fixed redline/schema context plus changed files, located symbols, and static findings. High-risk static findings are reviewed first, and large diffs are split according to `options.max_ai_input_tokens` or `ai.max_input_tokens` in the request.

AI output can be bounded per task:

```json
{
  "ai": {
    "max_output_tokens": 8000,
    "max_findings_per_chunk": 20
  }
}
```

`max_output_tokens` is translated per provider: OpenAI uses `max_completion_tokens`, Anthropic and OpenAI-compatible providers use `max_tokens`, and Gemini uses `generationConfig.maxOutputTokens`. `max_findings_per_chunk` is included in the prompt constraints and enforced after each chunk response; dropped findings are reflected in `ai_usage.output_truncated`, `ai_usage.dropped_findings`, and `ai_usage.aggregation`.

If the provider returns malformed JSON, the adapter sends one repair request asking for a valid `{ "findings": [] }` object. If repair still fails, the task continues and emits a `MANUAL_REVIEW_REQUIRED` warning finding with the provider error in evidence; `ai_usage.degraded` is set to `true`.

## Built-in deterministic rules

Global redlines use `global:redlines#...` rule sources and are intended for blocking security or reliability risks. Language-specific pitfalls use `global:language-rules#...` and currently cover Python mutable default arguments, Lua ignored `pcall` results, Java `printStackTrace`, and C++ raw `new` ownership review. These rules are used by the Node rule engine and injected into AI review context so AI findings can cite the same rule IDs.

## Repository review config

The analyzer first applies project-level review settings from `config/projects.json`, then reads `.review-config.yaml` or `.review-config.json` from the target revision worktree. Repository config can add rule documents for AI context and regex-based custom rules for deterministic scanning:

```yaml
version: "1.0"
project:
  languages: ["python"]
rules:
  redline_documents:
    - "docs/security/redlines.md"
  style_documents:
    - "docs/coding-style/python.md"
  custom_rules:
    - id: "PY-SERVICE-ANNOTATION"
      language: "python"
      severity: "WARNING"
      category: "Style"
      description: "Service functions should expose type annotations."
      pattern: "^def service_[^(]+\\([^)]*\\):"
      suggestion: "Add explicit argument and return type annotations."
tools:
  tree_sitter_symbol_locator:
    - id: "tree-sitter-python"
      language: "python"
      command: "/opt/impact-tools/tree-sitter-symbols"
      args: ["--language", "python"]
      parser: "json-symbols"
      timeout_ms: 30000
  static_tools:
    - id: "ruff"
      language: "python"
      command: "/opt/impact-tools/ruff/ruff"
      args: ["check", "--output-format", "json", "."]
      parser: "json-findings"
      timeout_ms: 30000
  lsp_call_hierarchy:
    - id: "pyright-wrapper"
      language: "python"
      command: "/opt/impact-tools/pyright-wrapper"
      args: ["--call-hierarchy-json"]
      parser: "json-impact"
      timeout_ms: 60000
ai:
  max_input_tokens: 120000
```

Repository document paths must be relative paths inside the repository. Paths such as `../security.md` and absolute paths are rejected.

When project-level and repository-level review config are both present, project settings are merged first and repository settings are appended afterward. Project custom rules are reported as `project:config#...`; repository custom rules are reported as `repo:.review-config.yaml#...`.

Static tools run from the checked-out target worktree. A tool should emit either a JSON array of findings or `{ "findings": [...] }`; findings are normalized into the main report and tool run metadata is written to `static-tool-runs.json`.

Tree-sitter symbol locator wrappers run from the checked-out target worktree before heuristic symbol parsing. They receive `IMPACT_FILE_CHANGES` as JSON and `IMPACT_CHANGED_FILES` as a JSON file list in the environment, and should emit either a JSON array of symbol ranges or `{ "symbols": [...] }`. Each range should include `file`, `name` or `symbol`, `kind`, `language`, `start_line`, and `end_line`. Matching changed lines are marked with `source: "Tree-sitter"` and run metadata is written to `tree-sitter-tool-runs.json`.

LSP call hierarchy wrappers also run from the target worktree. They receive `IMPACT_SYMBOLS` as JSON in the environment and should emit either a JSON array of impact entries or `{ "impact_tree": [...] }`. Matching LSP entries replace static-reference impact entries and tool run metadata is written to `lsp-tool-runs.json`.
