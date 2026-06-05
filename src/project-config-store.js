const fs = require('node:fs/promises');

const SECRET_FIELDS = new Set(['credential_ref', 'credential', 'token', 'api_key', 'secret']);

class ProjectConfigStore {
  constructor({ configPath }) {
    this.configPath = configPath;
  }

  async list() {
    if (!this.configPath) return [];
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      return normalizeProjects(parsed.projects || parsed);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async listPublic() {
    const projects = await this.list();
    return projects.map(redactProjectConfig);
  }

  async get(name) {
    const projects = await this.list();
    return projects.find((project) => project.name === name) || null;
  }

  async getPublic(name) {
    const project = await this.get(name);
    return project ? redactProjectConfig(project) : null;
  }
}

function normalizeProjects(projects) {
  if (!Array.isArray(projects)) return [];
  return projects
    .filter((project) => project && project.name)
    .map((project) => ({
      name: String(project.name),
      repository_full_name: project.repository_full_name || '',
      clone_url: project.clone_url || '',
      default_branch: project.default_branch || 'main',
      credential_ref: project.credential_ref || '',
      languages: asArray(project.languages),
      options: project.options || {},
      ai: project.ai || {},
      rules: project.rules || {},
      tools: project.tools || {},
      rule_documents: asArray(project.rule_documents),
      retention_days: project.retention_days,
      protected_branch_retention_days: project.protected_branch_retention_days
    }));
}

function mergeProjectConfigIntoRequest({ projectConfig, request }) {
  if (!projectConfig) return clone(request);
  const merged = clone(request);
  merged.project = {
    name: merged.project && merged.project.name ? merged.project.name : projectConfig.name,
    repository_full_name: projectConfig.repository_full_name || undefined,
    clone_url: projectConfig.clone_url || undefined,
    default_branch: projectConfig.default_branch || undefined,
    credential_ref: projectConfig.credential_ref || undefined,
    ...(merged.project || {})
  };
  if (!merged.languages || merged.languages.length === 0) {
    merged.languages = [...(projectConfig.languages || [])];
  }
  merged.options = {
    ...(projectConfig.options || {}),
    ...(merged.options || {})
  };
  merged.ai = {
    ...(projectConfig.ai || {}),
    ...(merged.ai || {})
  };
  merged.project_config = {
    rules: projectConfig.rules || {},
    tools: projectConfig.tools || {},
    ai: projectConfig.ai || {},
    rule_documents: projectConfig.rule_documents || []
  };
  if (merged.retention_days === undefined && projectConfig.retention_days !== undefined) {
    merged.retention_days = projectConfig.retention_days;
  }
  if (merged.protected_branch_retention_days === undefined && projectConfig.protected_branch_retention_days !== undefined) {
    merged.protected_branch_retention_days = projectConfig.protected_branch_retention_days;
  }
  return merged;
}

function redactProjectConfig(project) {
  const redacted = {};
  for (const [key, value] of Object.entries(project || {})) {
    if (SECRET_FIELDS.has(key) || key.endsWith('_secret')) continue;
    redacted[key] = value;
  }
  return redacted;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

module.exports = {
  ProjectConfigStore,
  mergeProjectConfigIntoRequest,
  redactProjectConfig
};
