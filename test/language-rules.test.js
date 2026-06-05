const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDiff } = require('../src/diff-parser');
const { scanRules } = require('../src/rule-engine');

test('scanRules flags Python mutable default arguments', () => {
  const findings = scanRules(parseDiff(`diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -1,1 +1,2 @@
+def append_user(user, users=[]):
+    users.append(user)
`));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule_id, 'LANG-PY-MUTABLE-DEFAULT-001');
  assert.equal(findings[0].severity, 'WARNING');
  assert.equal(findings[0].rule_source, 'global:language-rules#LANG-PY-MUTABLE-DEFAULT-001');
});

test('scanRules flags Lua pcall results that are ignored', () => {
  const findings = scanRules(parseDiff(`diff --git a/init.lua b/init.lua
--- a/init.lua
+++ b/init.lua
@@ -1,1 +1,2 @@
+pcall(load_plugin)
+return M
`));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule_id, 'LANG-LUA-PCALL-001');
});

test('scanRules flags Java printStackTrace exception handling', () => {
  const findings = scanRules(parseDiff(`diff --git a/App.java b/App.java
--- a/App.java
+++ b/App.java
@@ -1,1 +1,2 @@
+catch (Exception e) { e.printStackTrace(); }
+return true;
`));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule_id, 'LANG-JAVA-PRINTSTACKTRACE-001');
});

test('scanRules flags C++ raw new allocations', () => {
  const findings = scanRules(parseDiff(`diff --git a/app.cpp b/app.cpp
--- a/app.cpp
+++ b/app.cpp
@@ -1,1 +1,2 @@
+auto user = new User(name);
+return user;
`));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule_id, 'LANG-CPP-RAII-001');
});
