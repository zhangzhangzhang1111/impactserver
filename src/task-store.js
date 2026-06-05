const fs = require('node:fs/promises');
const path = require('node:path');

class TaskStore {
  constructor({ runtimeDir }) {
    this.tasksDir = path.join(runtimeDir, 'tasks');
  }

  async ensure() {
    await fs.mkdir(this.tasksDir, { recursive: true });
  }

  pathFor(taskId) {
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  async save(task) {
    await this.ensure();
    await fs.writeFile(this.pathFor(task.task_id), JSON.stringify(task, null, 2));
    return task;
  }

  async get(taskId) {
    try {
      const raw = await fs.readFile(this.pathFor(taskId), 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async list() {
    await this.ensure();
    const names = await fs.readdir(this.tasksDir);
    const tasks = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const raw = await fs.readFile(path.join(this.tasksDir, name), 'utf8');
      tasks.push(JSON.parse(raw));
    }
    return tasks;
  }

  async findByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) return null;
    const tasks = await this.list();
    return tasks.find((task) => task.idempotency_key === idempotencyKey) || null;
  }

  async delete(taskId) {
    try {
      await fs.rm(this.pathFor(taskId), { force: true });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
}

module.exports = { TaskStore };
