function safeSegment(value) {
  return String(value || 'unknown')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}

module.exports = { safeSegment };
