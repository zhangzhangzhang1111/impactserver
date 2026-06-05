const test = require('node:test');
const assert = require('node:assert/strict');
const { runStaticTools, parseJsonFindings } = require('../src/static-tool-runner');

test('parseJsonFindings accepts array or object finding payloads', () => {
  assert.equal(parseJsonFindings(JSON.stringify([{ file: 'a.py', line: 1, rule_id: 'R1' }])).length, 1);
  assert.equal(parseJsonFindings(JSON.stringify({ findings: [{ file: 'b.py', line: 2, rule_id: 'R2' }] })).length, 1);
});

test('runStaticTools executes configured tool and normalizes findings', async () => {
  const calls = [];
  const result = await runStaticTools({
    repoPath: '/repo',
    fileChanges: [{ file: 'app.py', added_lines: [{ line: 2, text: 'print(password)' }] }],
    reviewConfig: {
      tools: {
        static_tools: [
          {
            id: 'fake-tool',
            language: 'python',
            command: 'fake-tool',
            args: ['--json'],
            parser: 'json-findings',
            timeout_ms: 1000
          }
        ]
      }
    },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({
          findings: [
            {
              file: 'app.py',
              line: 2,
              language: 'python',
              severity: 'WARNING',
              category: 'PrivacyProtection',
              rule_id: 'FAKE001',
              message: 'fake static finding',
              suggestion: 'mask the value',
              evidence: { code_excerpt: 'print(password)' }
            }
          ]
        }),
        stderr: ''
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'fake-tool');
  assert.deepEqual(calls[0].args, ['--json']);
  assert.equal(calls[0].options.cwd, '/repo');
  assert.equal(result.runs[0].status, 'SUCCESS');
  assert.equal(result.findings[0].rule_id, 'FAKE001');
  assert.equal(result.findings[0].rule_source, 'tool:fake-tool#FAKE001');
  assert.deepEqual(result.findings[0].source_engine, ['fake-tool']);
});
