const path = require('node:path');

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.lua') return 'lua';
  if (['.c', '.h'].includes(ext)) return 'c';
  if (['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'].includes(ext)) return 'cpp';
  if (ext === '.java') return 'java';
  if (ext === '.py') return 'python';
  return 'unknown';
}

module.exports = { detectLanguage };
