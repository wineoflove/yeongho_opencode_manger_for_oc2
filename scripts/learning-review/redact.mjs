export function redact(value) {
  return String(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED KEY]')
    .replace(/\b(?:Bearer\s+|sk-[\w-]*|gh[pousr]_|github_pat_)[A-Za-z0-9_.-]+/gi, '[REDACTED TOKEN]')
    .replace(
      /((?:password|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
}
