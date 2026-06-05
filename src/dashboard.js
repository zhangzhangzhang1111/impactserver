function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Impact Analysis Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fb;
      --surface: #ffffff;
      --line: #d8dee8;
      --text: #17202a;
      --muted: #657080;
      --accent: #2563eb;
      --ok: #16803c;
      --warn: #b45309;
      --bad: #b42318;
      --pending: #64748b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: var(--surface);
      padding: 18px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 20px auto 32px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric, .table-wrap {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { padding: 14px; }
    .metric span {
      color: var(--muted);
      display: block;
      font-size: 12px;
      margin-bottom: 6px;
    }
    .metric strong {
      font-size: 24px;
      line-height: 1.15;
    }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 920px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 11px 12px;
      text-align: left;
      vertical-align: middle;
      font-size: 14px;
    }
    th {
      background: #eef2f7;
      color: #3b4656;
      font-size: 12px;
      text-transform: uppercase;
    }
    tr:last-child td { border-bottom: 0; }
    .status {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 3px 8px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .SUCCESS { color: var(--ok); }
    .FAILED, .TIMEOUT { color: var(--bad); }
    .RUNNING { color: var(--accent); }
    .PENDING, .CANCELLED { color: var(--pending); }
    .progress {
      height: 8px;
      width: 130px;
      border-radius: 999px;
      overflow: hidden;
      background: #e5e9f0;
    }
    .progress div {
      height: 100%;
      background: var(--accent);
      width: 0%;
    }
    .links {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    a, button {
      color: var(--accent);
      font: inherit;
    }
    a {
      text-decoration: none;
      font-weight: 650;
    }
    button {
      border: 1px solid var(--line);
      background: var(--surface);
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
    }
    .muted { color: var(--muted); }
    .error { color: var(--bad); max-width: 260px; overflow-wrap: anywhere; }
    @media (max-width: 760px) {
      header { padding: 16px; }
      main { width: calc(100vw - 20px); margin-top: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Impact Analysis Dashboard</h1>
    <button id="refresh" type="button">Refresh</button>
  </header>
  <main>
    <section class="summary" aria-label="Worker summary">
      <div class="metric"><span>Queued</span><strong id="queued">0</strong></div>
      <div class="metric"><span>Running</span><strong id="running">0</strong></div>
      <div class="metric"><span>Concurrency</span><strong id="concurrency">0</strong></div>
      <div class="metric"><span>Recent tasks</span><strong id="taskCount">0</strong></div>
    </section>
    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Project</th>
            <th>Status</th>
            <th>Stage</th>
            <th>Progress</th>
            <th>Branch</th>
            <th>Updated</th>
            <th>Report</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody id="tasks">
          <tr><td colspan="9" class="muted">Loading...</td></tr>
        </tbody>
      </table>
    </section>
  </main>
  <script>
    const endpoint = '/api/v1/dashboard?limit=50';
    const els = {
      queued: document.getElementById('queued'),
      running: document.getElementById('running'),
      concurrency: document.getElementById('concurrency'),
      taskCount: document.getElementById('taskCount'),
      tasks: document.getElementById('tasks')
    };

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function renderReportLinks(report) {
      if (!report || !report.available) return '<span class="muted">No report</span>';
      const links = [];
      if (report.html_url) links.push('<a href="' + report.html_url + '" target="_blank" rel="noreferrer">HTML</a>');
      if (report.json_url) links.push('<a href="' + report.json_url + '" target="_blank" rel="noreferrer">JSON</a>');
      if (report.markdown_url) links.push('<a href="' + report.markdown_url + '" target="_blank" rel="noreferrer">MD</a>');
      return '<span class="links">' + links.join('') + '</span>';
    }

    function renderTasks(tasks) {
      if (!tasks.length) {
        els.tasks.innerHTML = '<tr><td colspan="9" class="muted">No analysis tasks yet.</td></tr>';
        return;
      }
      els.tasks.innerHTML = tasks.map((task) => {
        const progress = Math.max(0, Math.min(100, Number(task.progress || 0)));
        return '<tr>' +
          '<td><code>' + escapeHtml(task.task_id) + '</code></td>' +
          '<td>' + escapeHtml(task.project_name) + '</td>' +
          '<td><span class="status ' + escapeHtml(task.status) + '">' + escapeHtml(task.status) + '</span></td>' +
          '<td>' + escapeHtml(task.stage) + '</td>' +
          '<td><div class="progress" aria-label="' + progress + '%"><div style="width:' + progress + '%"></div></div></td>' +
          '<td>' + escapeHtml(task.branch || '') + '</td>' +
          '<td class="muted">' + escapeHtml(task.updated_at || '') + '</td>' +
          '<td>' + renderReportLinks(task.report) + '</td>' +
          '<td class="error">' + escapeHtml(task.error || '') + '</td>' +
        '</tr>';
      }).join('');
    }

    async function loadDashboard() {
      const token = sessionStorage.getItem('impactApiToken') || '';
      const response = await fetch(endpoint, {
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      });
      if (response.status === 401) {
        const nextToken = window.prompt('API token');
        if (nextToken) {
          sessionStorage.setItem('impactApiToken', nextToken);
          return loadDashboard();
        }
      }
      if (!response.ok) throw new Error('dashboard API returned ' + response.status);
      const data = await response.json();
      els.queued.textContent = data.worker.queued;
      els.running.textContent = data.worker.running;
      els.concurrency.textContent = data.worker.concurrency;
      els.taskCount.textContent = data.tasks.length;
      renderTasks(data.tasks);
    }

    document.getElementById('refresh').addEventListener('click', () => {
      loadDashboard().catch((error) => {
        els.tasks.innerHTML = '<tr><td colspan="9" class="error">' + escapeHtml(error.message) + '</td></tr>';
      });
    });

    loadDashboard().catch((error) => {
      els.tasks.innerHTML = '<tr><td colspan="9" class="error">' + escapeHtml(error.message) + '</td></tr>';
    });
    setInterval(loadDashboard, 5000);
  </script>
</body>
</html>
`;
}

module.exports = { renderDashboardHtml };
