const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskRunner } = require('../src/task-runner');

test('TaskRunner runs queued tasks with configured concurrency', async () => {
  const started = [];
  const finished = [];
  const first = deferred();
  const runner = new TaskRunner({
    concurrency: 1,
    runTask: async (taskId) => {
      started.push(taskId);
      if (taskId === 'task_1') await first.promise;
      finished.push(taskId);
    }
  });

  const firstRun = runner.enqueue('task_1');
  const secondRun = runner.enqueue('task_2');
  await tick();

  assert.deepEqual(started, ['task_1']);
  assert.equal(runner.stats().queued, 1);
  assert.equal(runner.stats().running, 1);

  first.resolve();
  await firstRun;
  await secondRun;

  assert.deepEqual(started, ['task_1', 'task_2']);
  assert.deepEqual(finished, ['task_1', 'task_2']);
  assert.equal(runner.stats().queued, 0);
  assert.equal(runner.stats().running, 0);
});

test('TaskRunner can cancel a queued task before it starts', async () => {
  const started = [];
  const first = deferred();
  const runner = new TaskRunner({
    concurrency: 1,
    runTask: async (taskId) => {
      started.push(taskId);
      if (taskId === 'task_1') await first.promise;
    }
  });

  const firstRun = runner.enqueue('task_1');
  const secondRun = runner.enqueue('task_2');
  await tick();

  assert.equal(runner.cancelQueued('task_2'), true);
  first.resolve();
  await firstRun;
  await assert.rejects(secondRun, /cancelled/);
  assert.deepEqual(started, ['task_1']);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
