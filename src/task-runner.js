class TaskRunner {
  constructor({ concurrency = 1, runTask }) {
    this.concurrency = Math.max(1, Number(concurrency || 1));
    this.runTask = runTask;
    this.queue = [];
    this.running = 0;
  }

  enqueue(taskId) {
    const item = {
      taskId,
      started: false,
      promise: null,
      resolve: null,
      reject: null
    };
    item.promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    this.queue.push(item);
    this.drain();
    return item.promise;
  }

  cancelQueued(taskId) {
    const index = this.queue.findIndex((item) => item.taskId === taskId && !item.started);
    if (index === -1) return false;
    const [item] = this.queue.splice(index, 1);
    item.reject(new Error(`task ${taskId} cancelled before execution`));
    return true;
  }

  stats() {
    return {
      queued: this.queue.length,
      running: this.running,
      concurrency: this.concurrency
    };
  }

  drain() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      item.started = true;
      this.running += 1;
      this.execute(item);
    }
  }

  async execute(item) {
    try {
      const result = await this.runTask(item.taskId);
      this.running -= 1;
      this.drain();
      item.resolve(result);
    } catch (error) {
      this.running -= 1;
      this.drain();
      item.reject(error);
    }
  }
}

module.exports = { TaskRunner };
