function parseDiff(patch) {
  const files = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of String(patch || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = {
        old_file: match ? match[1] : null,
        file: match ? match[2] : null,
        hunks: [],
        added_lines: []
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('+++ b/')) {
      current.file = line.slice('+++ b/'.length);
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.hunks.push({ header: line, old_start: oldLine, new_start: newLine });
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.added_lines.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      oldLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }

  if (current) files.push(current);
  return files.filter((file) => file.file);
}

module.exports = { parseDiff };
