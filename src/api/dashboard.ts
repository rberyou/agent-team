/**
 * Dashboard HTML template - single-file SPA for real-time project monitoring.
 * Served as GET / by the Fastify server.
 */
export function getDashboardHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Team Dashboard</title>
<style>
  :root {
    --bg-primary: #0d1117;
    --bg-secondary: #161b22;
    --bg-tertiary: #21262d;
    --border: #30363d;
    --text-primary: #e6edf3;
    --text-secondary: #8b949e;
    --text-muted: #6e7681;
    --accent-blue: #58a6ff;
    --accent-green: #3fb950;
    --accent-orange: #d29922;
    --accent-red: #f85149;
    --accent-purple: #bc8cff;
    --accent-cyan: #39d2c0;
    --radius: 8px;
    --shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    line-height: 1.5;
    min-height: 100vh;
  }

  /* Header */
  .header {
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header h1 span { color: var(--accent-blue); }
  .ws-status {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; color: var(--text-secondary);
  }
  .ws-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent-red);
    transition: background 0.3s;
  }
  .ws-dot.connected { background: var(--accent-green); }

  /* Layout */
  .container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 20px 24px;
    display: grid;
    grid-template-columns: 1fr 360px;
    gap: 20px;
  }
  @media (max-width: 960px) {
    .container { grid-template-columns: 1fr; }
  }

  /* Cards */
  .card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .card-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .card-body { padding: 16px; }

  /* Phase progress */
  .phase-bar {
    display: flex; gap: 4px; margin-bottom: 16px;
  }
  .phase-step {
    flex: 1;
    text-align: center;
    padding: 8px 4px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    border: 1px solid transparent;
    transition: all 0.3s;
  }
  .phase-step.active {
    background: rgba(88,166,255,0.15);
    color: var(--accent-blue);
    border-color: var(--accent-blue);
  }
  .phase-step.completed {
    background: rgba(63,185,80,0.15);
    color: var(--accent-green);
    border-color: var(--accent-green);
  }

  /* Project info */
  .project-info {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 16px;
  }
  .info-item { font-size: 13px; }
  .info-label { color: var(--text-muted); margin-bottom: 2px; }
  .info-value { color: var(--text-primary); font-weight: 500; }

  /* Badge */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-active { background: rgba(88,166,255,0.2); color: var(--accent-blue); }
  .badge-completed { background: rgba(63,185,80,0.2); color: var(--accent-green); }
  .badge-pending { background: rgba(110,118,129,0.2); color: var(--text-muted); }
  .badge-created { background: rgba(188,140,255,0.2); color: var(--accent-purple); }

  /* Task board */
  .task-list { display: flex; flex-direction: column; gap: 10px; }
  .phase-group { }
  .phase-group-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; cursor: pointer; border-radius: 6px;
    background: var(--bg-secondary); border: 1px solid var(--border);
    user-select: none; font-size: 13px; font-weight: 600;
  }
  .phase-group-header:hover { background: var(--bg-tertiary); }
  .phase-group-header .phase-group-left { display: flex; align-items: center; gap: 8px; }
  .phase-group-header .arrow { transition: transform 0.2s; font-size: 10px; color: var(--text-muted); }
  .phase-group-header.collapsed .arrow { transform: rotate(-90deg); }
  .phase-group-body { padding-top: 4px; display: flex; flex-direction: column; gap: 4px; }
  .phase-group-body.collapsed { display: none; }
  .phase-group-count { font-size: 11px; font-weight: 400; color: var(--text-muted); }
  .phase-group-stats { font-size: 11px; color: var(--text-muted); }
  .task-item {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px;
    background: var(--bg-tertiary);
    border-radius: 6px;
    font-size: 13px;
    border-left: 3px solid var(--border);
    margin-left: 8px;
  }
  .task-item.status-in_progress { border-left-color: var(--accent-blue); }
  .task-item.status-in_review { border-left-color: var(--accent-orange); }
  .task-item.status-done { border-left-color: var(--accent-green); }
  .task-item.status-pending { border-left-color: var(--text-muted); }
  .task-item.status-blocked { border-left-color: var(--accent-red); }
  .task-title { flex: 1; }
  .task-status-badge {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 600;
  }
  .task-status-badge.in_progress { background: rgba(88,166,255,0.15); color: var(--accent-blue); }
  .task-status-badge.in_review { background: rgba(210,153,34,0.15); color: var(--accent-orange); }
  .task-status-badge.done { background: rgba(63,185,80,0.15); color: var(--accent-green); }
  .task-status-badge.pending { background: rgba(110,118,129,0.15); color: var(--text-muted); }
  .task-status-badge.blocked { background: rgba(248,81,73,0.15); color: var(--accent-red); }

  /* Action panel */
  .action-panel {
    margin-top: 16px;
    padding: 16px;
    background: rgba(210,153,34,0.08);
    border: 1px solid rgba(210,153,34,0.3);
    border-radius: var(--radius);
    display: none;
  }
  .action-panel.visible { display: block; }
  .action-panel h3 {
    font-size: 14px;
    color: var(--accent-orange);
    margin-bottom: 8px;
  }
  .action-panel p {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 12px;
  }
  .action-buttons { display: flex; gap: 8px; }
  .btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-confirm { background: var(--accent-green); color: #fff; }
  .btn-reject { background: var(--accent-red); color: #fff; }
  .btn-primary { background: var(--accent-blue); color: #fff; }
  .btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); }

  /* Event timeline */
  .timeline { max-height: 520px; overflow-y: auto; }
  .timeline::-webkit-scrollbar { width: 6px; }
  .timeline::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  .event-item {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .event-item:last-child { border-bottom: none; }
  .event-time { color: var(--text-muted); font-family: monospace; }
  .event-type {
    color: var(--accent-cyan);
    font-family: monospace;
    font-weight: 500;
  }
  .event-source { color: var(--text-muted); }

  /* Create project */
  .create-section {
    margin-bottom: 20px;
    display: flex;
    gap: 8px;
  }
  .create-section input, .create-section textarea {
    flex: 1;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    resize: vertical;
  }
  .create-section input:focus, .create-section textarea:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  /* Artifact list */
  .artifact-list { display: flex; flex-direction: column; gap: 4px; }
  .artifact-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .artifact-item:hover { background: var(--border); }
  .artifact-phase { color: var(--text-muted); }

  /* Modal */
  .modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 200;
    justify-content: center;
    align-items: center;
  }
  .modal-overlay.visible { display: flex; }
  .modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    width: 90%;
    max-width: 720px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
  }
  .modal-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .modal-header h3 { font-size: 16px; }
  .modal-close {
    background: none; border: none;
    color: var(--text-secondary);
    font-size: 20px; cursor: pointer;
  }
  .modal-body {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
  }
  .modal-body pre {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    font-size: 13px;
    font-family: 'SF Mono', Menlo, monospace;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 40px 20px;
    color: var(--text-muted);
  }
  .empty-state h3 { font-size: 16px; margin-bottom: 8px; color: var(--text-secondary); }
  .empty-state p { font-size: 13px; }

  /* Reject modal */
  .reject-textarea {
    width: 100%;
    min-height: 80px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    resize: vertical;
    margin-bottom: 12px;
  }
  .reject-textarea:focus { outline: none; border-color: var(--accent-blue); }

  /* Scrollbar for main */
  .main-col { min-width: 0; }
  .right-col { min-width: 0; }

  /* No-project state */
  .no-project { display: none; }
  .no-project.visible { display: block; }
  .has-project { display: none; }
  .has-project.visible { display: block; }
</style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <h1><span>Agent Team</span> Dashboard</h1>
    <div class="ws-status">
      <div class="ws-dot" id="wsDot"></div>
      <span id="wsLabel">Disconnected</span>
    </div>
  </div>

  <div class="container">
    <!-- Main column -->
    <div class="main-col">
      <!-- Create Project -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">New Project</div>
        <div class="card-body">
          <div style="display:flex;flex-direction:column;gap:8px">
            <input type="text" id="projectName" placeholder="Project name (optional)">
            <textarea id="requirement" rows="3" placeholder="Enter your requirement here..."></textarea>
            <div style="display:flex;align-items:center;gap:8px">
              <label style="display:flex;align-items:center;gap:4px;font-size:13px;color:var(--text-secondary);cursor:pointer">
                <input type="checkbox" id="requiresUI"> Requires UI Design
              </label>
            </div>
            <div><button class="btn btn-primary" id="createBtn" onclick="createProject()">Submit Requirement</button></div>
          </div>
        </div>
      </div>

      <!-- No project state -->
      <div class="no-project visible" id="noProject">
        <div class="card">
          <div class="card-body">
            <div class="empty-state">
              <h3>No Active Project</h3>
              <p>Submit a requirement above to create a new project, or select an existing project from the list.</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Has project state -->
      <div class="has-project" id="hasProject">
        <!-- Phase progress -->
        <div class="card" style="margin-bottom:16px">
          <div class="card-header">
            <span>Phase Progress</span>
            <span class="badge" id="projectStatusBadge">-</span>
          </div>
          <div class="card-body">
            <div class="phase-bar" id="phaseBar">
              <div class="phase-step" data-phase="analysis">Analysis</div>
              <div class="phase-step" data-phase="design">Design</div>
              <div class="phase-step" data-phase="implementation">Implementation</div>
              <div class="phase-step" data-phase="testing">Testing</div>
              <div class="phase-step" data-phase="acceptance">Acceptance</div>
            </div>
            <div class="project-info" id="projectInfo"></div>
          </div>
        </div>

        <!-- Action panel -->
        <div class="action-panel" id="actionPanel">
          <h3 id="actionTitle">Action Required</h3>
          <p id="actionDesc"></p>
          <div class="action-buttons">
            <button class="btn btn-confirm" id="confirmBtn" onclick="confirmAction()">Approve</button>
            <button class="btn btn-reject" id="rejectBtn" onclick="showRejectModal()">Reject</button>
          </div>
        </div>

        <!-- Tasks -->
        <div class="card" style="margin-bottom:16px">
          <div class="card-header">
            <span>Tasks</span>
            <span id="taskCount" style="font-size:12px;color:var(--text-muted)"></span>
          </div>
          <div class="card-body">
            <div class="task-list" id="taskList"></div>
          </div>
        </div>

        <!-- Artifacts -->
        <div class="card">
          <div class="card-header">Artifacts</div>
          <div class="card-body">
            <div class="artifact-list" id="artifactList"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Right column -->
    <div class="right-col">
      <!-- Project list -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-header">
          <span>Projects</span>
          <button class="btn btn-secondary" style="padding:4px 10px;font-size:11px" onclick="loadProjects()">Refresh</button>
        </div>
        <div class="card-body" id="projectListBody">
          <div style="color:var(--text-muted);font-size:13px">Loading...</div>
        </div>
      </div>

      <!-- Event timeline -->
      <div class="card">
        <div class="card-header">
          <span>Event Timeline</span>
          <span id="eventCount" style="font-size:12px;color:var(--text-muted)">0 events</span>
        </div>
        <div class="card-body" style="padding:8px 16px">
          <div class="timeline" id="timeline"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Artifact modal -->
  <div class="modal-overlay" id="artifactModal">
    <div class="modal">
      <div class="modal-header">
        <h3 id="artifactModalTitle">Artifact</h3>
        <button class="modal-close" onclick="closeArtifactModal()">&times;</button>
      </div>
      <div class="modal-body">
        <pre id="artifactContent"></pre>
      </div>
    </div>
  </div>

  <!-- Reject modal -->
  <div class="modal-overlay" id="rejectModal">
    <div class="modal" style="max-width:480px">
      <div class="modal-header">
        <h3>Rejection Feedback</h3>
        <button class="modal-close" onclick="closeRejectModal()">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">Please provide feedback for rejection:</p>
        <textarea class="reject-textarea" id="rejectFeedback" placeholder="Enter your feedback..."></textarea>
        <div class="action-buttons">
          <button class="btn btn-reject" onclick="rejectAction()">Submit Rejection</button>
          <button class="btn btn-secondary" onclick="closeRejectModal()">Cancel</button>
        </div>
      </div>
    </div>
  </div>

<script>
// ---- State ----
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let currentProjectId = null;
let pendingConfirmation = null; // { confirmationType, taskId }
let events = [];
const collapsedPhases = new Set();

const API = '';
const PHASES = ['analysis','design','implementation','testing','acceptance'];
const PHASE_LABELS = { analysis:'Analysis', design:'Design', implementation:'Implementation', testing:'Testing', acceptance:'Acceptance' };
const CONFIRM_LABELS = {
  prd_review: 'PRD Review',
  design_review: 'Design Review',
  ui_review: 'UI Design Review',
  code_review: 'Code Review',
  test_review: 'Test Report Review',
  acceptance_review: 'Acceptance Review',
  deployment_review: 'Deployment Review',
};

// ---- WebSocket ----
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + location.host + '/ws');

  ws.onopen = () => {
    document.getElementById('wsDot').classList.add('connected');
    document.getElementById('wsLabel').textContent = 'Connected';
    reconnectDelay = 1000;
  };

  ws.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data);
      handleEvent(event);
    } catch(e) { /* ignore */ }
  };

  ws.onclose = () => {
    document.getElementById('wsDot').classList.remove('connected');
    document.getElementById('wsLabel').textContent = 'Reconnecting...';
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectWS();
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  }, reconnectDelay);
}

// ---- Event handling ----
function handleEvent(event) {
  // Add to timeline
  events.unshift(event);
  if (events.length > 200) events.pop();
  renderTimeline();

  // If event belongs to current project, refresh data
  if (currentProjectId && event.projectId === currentProjectId) {
    refreshProject();
  }

  // Handle confirmation_needed
  if (event.type === 'user.confirmation_needed' && event.projectId === currentProjectId) {
    pendingConfirmation = {
      confirmationType: event.payload.confirmationType,
      taskId: event.payload.taskId,
    };
    showActionPanel();
  }

  // If a new project was created, refresh project list
  if (event.type === 'project.created') {
    loadProjects();
    if (!currentProjectId) {
      currentProjectId = event.projectId;
      refreshProject();
    }
  }
}

// ---- API calls ----
async function apiGet(path) {
  const res = await fetch(API + path);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---- Create project ----
async function createProject() {
  const requirement = document.getElementById('requirement').value.trim();
  if (!requirement) return;
  const projectName = document.getElementById('projectName').value.trim();
  const requiresUI = document.getElementById('requiresUI').checked;

  const btn = document.getElementById('createBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const data = await apiPost('/api/projects', { requirement, projectName: projectName || undefined, requiresUI });
    if (data.project) {
      currentProjectId = data.project.projectId;
      document.getElementById('requirement').value = '';
      document.getElementById('projectName').value = '';
      refreshProject();
      loadProjects();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit Requirement';
  }
}

// ---- Load projects list ----
async function loadProjects() {
  const data = await apiGet('/api/projects');
  const body = document.getElementById('projectListBody');
  if (!data.projects || data.projects.length === 0) {
    body.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No projects yet</div>';
    return;
  }
  body.innerHTML = data.projects.map(p => {
    const isActive = p.projectId === currentProjectId;
    return '<div style="padding:8px 10px;border-radius:6px;cursor:pointer;margin-bottom:4px;'
      + 'background:' + (isActive ? 'var(--bg-tertiary)' : 'transparent') + ';'
      + 'border:1px solid ' + (isActive ? 'var(--accent-blue)' : 'transparent') + '"'
      + ' onclick="selectProject(\\''+p.projectId+'\\')\">'
      + '<div style="font-size:13px;font-weight:500">' + esc(p.name) + '</div>'
      + '<div style="font-size:11px;color:var(--text-muted);display:flex;justify-content:space-between;margin-top:2px">'
      + '<span>' + (p.currentPhase || p.status) + '</span>'
      + '<span class="badge badge-' + p.status + '">' + p.status + '</span>'
      + '</div></div>';
  }).join('');
}

function selectProject(id) {
  currentProjectId = id;
  pendingConfirmation = null;
  hideActionPanel();
  refreshProject();
  loadProjects();
}

// ---- Refresh project data ----
async function refreshProject() {
  if (!currentProjectId) return;

  document.getElementById('noProject').classList.remove('visible');
  document.getElementById('hasProject').classList.add('visible');

  // Fetch project, tasks, artifacts in parallel
  const [projData, taskData, confirmData] = await Promise.all([
    apiGet('/api/projects/' + currentProjectId),
    apiGet('/api/projects/' + currentProjectId + '/tasks'),
    apiGet('/api/projects/' + currentProjectId + '/pending-confirmation'),
  ]);

  if (!projData.project) return;
  const project = projData.project;
  const tasks = taskData.tasks || [];

  // Update pending confirmation from server
  if (confirmData.pendingConfirmation) {
    pendingConfirmation = {
      confirmationType: confirmData.pendingConfirmation.payload.confirmationType,
      taskId: confirmData.pendingConfirmation.payload.taskId,
    };
    showActionPanel();
  } else {
    pendingConfirmation = null;
    hideActionPanel();
  }

  // Update phase bar
  updatePhaseBar(project);

  // Update project info
  const info = document.getElementById('projectInfo');
  info.innerHTML =
    '<div class="info-item"><div class="info-label">Name</div><div class="info-value">' + esc(project.name) + '</div></div>'
    + '<div class="info-item"><div class="info-label">Status</div><div class="info-value">' + project.status + '</div></div>'
    + '<div class="info-item"><div class="info-label">Current Phase</div><div class="info-value">' + (project.currentPhase || '-') + '</div></div>'
    + '<div class="info-item"><div class="info-label">Created</div><div class="info-value">' + fmtTime(project.createdAt) + '</div></div>';

  // Update status badge
  const badge = document.getElementById('projectStatusBadge');
  badge.textContent = project.status;
  badge.className = 'badge badge-' + project.status;

  // Update tasks
  renderTasks(tasks);

  // Load artifacts
  await loadArtifacts(project);
}

function updatePhaseBar(project) {
  const steps = document.querySelectorAll('.phase-step');
  const currentPhase = project.currentPhase;
  const completedPhases = project.phases || [];

  steps.forEach(step => {
    const phase = step.dataset.phase;
    step.classList.remove('active', 'completed');
    if (phase === currentPhase) {
      step.classList.add('active');
    } else if (completedPhases.includes(phase) || (project.status === 'completed' && PHASES.indexOf(phase) <= PHASES.indexOf('acceptance'))) {
      step.classList.add('completed');
    }
  });
}

function renderTasks(tasks) {
  const list = document.getElementById('taskList');
  const totalCount = tasks.length;
  document.getElementById('taskCount').textContent = totalCount + ' tasks';
  if (totalCount === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px">No tasks yet</div>';
    return;
  }

  // Group tasks by phase in PHASES order
  let html = '';
  for (const phase of PHASES) {
    const phaseTasks = tasks.filter(t => t.phase === phase);
    if (phaseTasks.length === 0) continue;

    const doneCount = phaseTasks.filter(t => t.status === 'done').length;
    const isCollapsed = collapsedPhases.has(phase);
    const label = PHASE_LABELS[phase] || phase;

    html += '<div class="phase-group">'
      + '<div class="phase-group-header' + (isCollapsed ? ' collapsed' : '') + '" onclick="togglePhaseGroup(\\'' + phase + '\\')">'
      + '<div class="phase-group-left">'
      + '<span class="arrow">&#9660;</span>'
      + '<span>' + label + '</span>'
      + '<span class="phase-group-count">' + phaseTasks.length + ' tasks</span>'
      + '</div>'
      + '<span class="phase-group-stats">' + doneCount + '/' + phaseTasks.length + ' done</span>'
      + '</div>'
      + '<div class="phase-group-body' + (isCollapsed ? ' collapsed' : '') + '" id="phase-body-' + phase + '">';

    for (const t of phaseTasks) {
      html += '<div class="task-item status-' + t.status + '">'
        + '<span class="task-title">' + esc(t.title) + '</span>'
        + '<span class="task-status-badge ' + t.status + '">' + t.status.replace('_', ' ') + '</span>'
        + '</div>';
    }

    html += '</div></div>';
  }
  list.innerHTML = html;
}

function togglePhaseGroup(phase) {
  if (collapsedPhases.has(phase)) {
    collapsedPhases.delete(phase);
  } else {
    collapsedPhases.add(phase);
  }
  const headers = document.querySelectorAll('.phase-group-header');
  headers.forEach(h => {
    if (h.getAttribute('onclick').includes(phase)) {
      h.classList.toggle('collapsed');
    }
  });
  const body = document.getElementById('phase-body-' + phase);
  if (body) body.classList.toggle('collapsed');
}

async function loadArtifacts(project) {
  const list = document.getElementById('artifactList');
  const allArtifacts = [];

  for (const phase of PHASES) {
    try {
      const data = await apiGet('/api/projects/' + project.projectId + '/artifacts/' + phase);
      if (data.artifacts && data.artifacts.length > 0) {
        for (const file of data.artifacts) {
          allArtifacts.push({ phase, file });
        }
      }
    } catch(e) { /* ignore */ }
  }

  if (allArtifacts.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px">No artifacts yet</div>';
    return;
  }
  list.innerHTML = allArtifacts.map(a =>
    '<div class="artifact-item" onclick="viewArtifact(\\''+a.phase+'\\',\\''+a.file+'\\')\">'
    + '<span>' + esc(a.file) + '</span>'
    + '<span class="artifact-phase">' + a.phase + '</span>'
    + '</div>'
  ).join('');
}

// ---- Artifact modal ----
async function viewArtifact(phase, filename) {
  document.getElementById('artifactModalTitle').textContent = phase + ' / ' + filename;
  document.getElementById('artifactContent').textContent = 'Loading...';
  document.getElementById('artifactModal').classList.add('visible');

  const data = await apiGet('/api/projects/' + currentProjectId + '/artifacts/' + phase + '/' + filename);
  if (data.artifact) {
    const content = typeof data.artifact === 'string' ? data.artifact : JSON.stringify(data.artifact, null, 2);
    document.getElementById('artifactContent').textContent = content;
  } else {
    document.getElementById('artifactContent').textContent = 'Failed to load artifact';
  }
}

function closeArtifactModal() {
  document.getElementById('artifactModal').classList.remove('visible');
}

// ---- Action panel ----
function showActionPanel() {
  if (!pendingConfirmation) return;
  const panel = document.getElementById('actionPanel');
  const label = CONFIRM_LABELS[pendingConfirmation.confirmationType] || pendingConfirmation.confirmationType;
  document.getElementById('actionTitle').textContent = 'Action Required: ' + label;

  if (pendingConfirmation.confirmationType === 'acceptance_trial' && currentProjectId) {
    const previewUrl = '/preview/' + currentProjectId + '/';
    document.getElementById('actionDesc').innerHTML =
      '<p style="margin-bottom:10px">Preview environment is ready. Open the preview to try the project, then approve or reject.</p>'
      + '<a href="' + previewUrl + '" target="_blank" style="display:inline-block;padding:8px 16px;background:var(--accent-blue);color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">Open Preview in Browser &rarr;</a>';
  } else {
    document.getElementById('actionDesc').textContent = 'A ' + label.toLowerCase() + ' is waiting for your approval. Please review the artifacts and confirm or reject.';
  }
  panel.classList.add('visible');
}

function hideActionPanel() {
  document.getElementById('actionPanel').classList.remove('visible');
}

async function confirmAction() {
  if (!pendingConfirmation || !currentProjectId) return;
  const btn = document.getElementById('confirmBtn');
  btn.disabled = true;
  try {
    await apiPost('/api/projects/' + currentProjectId + '/confirm', {
      confirmationType: pendingConfirmation.confirmationType,
      taskId: pendingConfirmation.taskId,
    });
    pendingConfirmation = null;
    hideActionPanel();
    setTimeout(() => refreshProject(), 300);
  } finally {
    btn.disabled = false;
  }
}

function showRejectModal() {
  document.getElementById('rejectFeedback').value = '';
  document.getElementById('rejectModal').classList.add('visible');
}

function closeRejectModal() {
  document.getElementById('rejectModal').classList.remove('visible');
}

async function rejectAction() {
  if (!pendingConfirmation || !currentProjectId) return;
  const feedback = document.getElementById('rejectFeedback').value.trim();
  await apiPost('/api/projects/' + currentProjectId + '/reject', {
    confirmationType: pendingConfirmation.confirmationType,
    taskId: pendingConfirmation.taskId,
    feedback,
  });
  pendingConfirmation = null;
  hideActionPanel();
  closeRejectModal();
  setTimeout(() => refreshProject(), 300);
}

// ---- Timeline ----
function renderTimeline() {
  const tl = document.getElementById('timeline');
  document.getElementById('eventCount').textContent = events.length + ' events';
  tl.innerHTML = events.slice(0, 100).map(e =>
    '<div class="event-item">'
    + '<div><span class="event-type">' + esc(e.type) + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;margin-top:2px">'
    + '<span class="event-source">' + esc(e.source) + '</span>'
    + '<span class="event-time">' + fmtTime(e.timestamp) + '</span>'
    + '</div></div>'
  ).join('');
}

// ---- Helpers ----
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function fmtTime(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  } catch { return iso; }
}

// ---- Init ----
connectWS();
loadProjects();

// Close modals on overlay click
document.getElementById('artifactModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeArtifactModal();
});
document.getElementById('rejectModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeRejectModal();
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeArtifactModal();
    closeRejectModal();
  }
});
</script>
</body>
</html>`;
}
