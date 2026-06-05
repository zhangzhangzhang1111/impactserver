const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { analyzeImpact } = require('../src/impact-analyzer');

test('analyzeImpact traces level 1 and level 2 callers with static references', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-impact-'));
  await fs.writeFile(path.join(repo, 'dao.py'), [
    'def get_user_by_name(name):',
    '    return name'
  ].join('\n'));
  await fs.writeFile(path.join(repo, 'service.py'), [
    'from dao import get_user_by_name',
    '',
    'def load_user(name):',
    '    return get_user_by_name(name)'
  ].join('\n'));
  await fs.writeFile(path.join(repo, 'api.py'), [
    'from service import load_user',
    '',
    'def login(name):',
    '    return load_user(name)'
  ].join('\n'));

  const impact = await analyzeImpact({
    repoPath: repo,
    symbols: [
      {
        file: 'dao.py',
        line: 2,
        language: 'python',
        symbol: 'get_user_by_name',
        confidence: 'MEDIUM',
        source: 'heuristic-symbol-locator'
      }
    ],
    maxDepth: 2
  });

  assert.equal(impact.length, 1);
  assert.equal(impact[0].modified_symbol, 'get_user_by_name');
  assert.deepEqual(impact[0].level_1_callers.map((caller) => caller.symbol), ['load_user']);
  assert.deepEqual(impact[0].level_2_callers.map((caller) => caller.symbol), ['login']);
  assert.equal(impact[0].source, 'static-reference');
  assert.equal(impact[0].confidence, 'MEDIUM');
  assert.ok(impact[0].limitations.some((item) => item.includes('dynamic')));
});
