const test = require('node:test');
const assert = require('node:assert/strict');
const { runLspCallHierarchy, mergeLspImpact } = require('../src/lsp-call-hierarchy');

test('runLspCallHierarchy executes configured wrapper and normalizes impact entries', async () => {
  const calls = [];
  const result = await runLspCallHierarchy({
    repoPath: '/repo',
    symbols: [
      {
        file: 'dao.py',
        symbol: 'get_user_by_name',
        language: 'python'
      }
    ],
    reviewConfig: {
      tools: {
        lsp_call_hierarchy: [
          {
            id: 'pyright-wrapper',
            language: 'python',
            command: 'pyright-wrapper',
            args: ['--json'],
            parser: 'json-impact'
          }
        ]
      }
    },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({
          impact_tree: [
            {
              modified_symbol: 'get_user_by_name',
              file: 'dao.py',
              language: 'python',
              confidence: 'HIGH',
              level_1_callers: [{ symbol: 'load_user', file: 'service.py', line: 4 }],
              level_2_callers: [{ symbol: 'login', file: 'api.py', line: 4 }],
              limitations: ['pyright wrapper limitation']
            }
          ]
        }),
        stderr: ''
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pyright-wrapper');
  assert.match(calls[0].options.env.IMPACT_SYMBOLS, /get_user_by_name/);
  assert.equal(result.runs[0].status, 'SUCCESS');
  assert.equal(result.impact_tree[0].source, 'LSP');
  assert.equal(result.impact_tree[0].level_1_callers[0].source, 'LSP');
});

test('mergeLspImpact prefers LSP entries over static reference entries', () => {
  const merged = mergeLspImpact([
    {
      modified_symbol: 'get_user_by_name',
      file: 'dao.py',
      source: 'static-reference',
      confidence: 'MEDIUM',
      level_1_callers: [{ symbol: 'load_user_static', file: 'service.py' }],
      level_2_callers: []
    }
  ], [
    {
      modified_symbol: 'get_user_by_name',
      file: 'dao.py',
      source: 'LSP',
      confidence: 'HIGH',
      level_1_callers: [{ symbol: 'load_user_lsp', file: 'service.py' }],
      level_2_callers: [{ symbol: 'login', file: 'api.py' }]
    }
  ]);

  assert.equal(merged[0].source, 'LSP');
  assert.equal(merged[0].confidence, 'HIGH');
  assert.equal(merged[0].level_1_callers[0].symbol, 'load_user_lsp');
});
