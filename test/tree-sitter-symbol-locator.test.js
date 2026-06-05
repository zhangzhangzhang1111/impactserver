const test = require('node:test');
const assert = require('node:assert/strict');
const { runTreeSitterSymbolLocator, mapChangedLinesToTreeSitterSymbols } = require('../src/tree-sitter-symbol-locator');

test('runTreeSitterSymbolLocator executes configured wrapper and maps changed lines to symbol ranges', async () => {
  const calls = [];
  const result = await runTreeSitterSymbolLocator({
    repoPath: '/repo',
    fileChanges: [
      {
        file: 'app.py',
        added_lines: [{ line: 3, content: '    return name.strip()' }]
      }
    ],
    reviewConfig: {
      tools: {
        tree_sitter_symbol_locator: [
          {
            id: 'tree-sitter-python',
            language: 'python',
            command: 'tree-sitter-wrapper',
            args: ['--symbols'],
            parser: 'json-symbols'
          }
        ]
      }
    },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({
          symbols: [
            {
              file: 'app.py',
              name: 'load_user',
              kind: 'function',
              language: 'python',
              start_line: 1,
              end_line: 4
            }
          ]
        }),
        stderr: ''
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'tree-sitter-wrapper');
  assert.match(calls[0].options.env.IMPACT_FILE_CHANGES, /app\.py/);
  assert.equal(result.runs[0].status, 'SUCCESS');
  assert.equal(result.symbols[0].source, 'Tree-sitter');

  const mapped = mapChangedLinesToTreeSitterSymbols({
    fileChanges: [{ file: 'app.py', added_lines: [{ line: 3 }] }],
    ranges: result.symbols
  });
  assert.equal(mapped.get('app.py:3').symbol, 'load_user');
  assert.equal(mapped.get('app.py:3').confidence, 'HIGH');
});

test('runTreeSitterSymbolLocator records failed wrapper runs without throwing', async () => {
  const result = await runTreeSitterSymbolLocator({
    repoPath: '/repo',
    fileChanges: [{ file: 'app.py', added_lines: [{ line: 1 }] }],
    reviewConfig: {
      tools: {
        tree_sitter_symbol_locator: [
          {
            id: 'bad-tree-sitter',
            language: 'python',
            command: 'bad-wrapper',
            parser: 'json-symbols'
          }
        ]
      }
    },
    execFileImpl: async () => {
      throw new Error('wrapper failed');
    }
  });

  assert.deepEqual(result.symbols, []);
  assert.equal(result.runs[0].status, 'FAILED');
  assert.match(result.runs[0].error, /wrapper failed/);
});
