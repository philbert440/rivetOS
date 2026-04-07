/**
 * Security scanner for skill content.
 *
 * Best-effort heuristic scan for unsafe patterns in SKILL.md
 * and supporting files. Blocks shell injection, credential leaks,
 * dangerous filesystem commands, and data exfiltration patterns.
 */

/** Scan skill content for unsafe patterns. Best-effort heuristic. */
export function scanSkillContent(content: string): { safe: boolean; issues: string[] } {
  const issues: string[] = []

  // Shell injection
  if (/\$\(/.test(content)) issues.push('Shell injection: $(...) command substitution')
  // Check for single-backtick shell execution (not triple-backtick code fences)
  // Match single backticks containing shell commands, but skip ``` code blocks
  if (/(?<!`)`(?!``)[^`]*\b(?:rm|curl|wget|cat|echo|sh|bash)\b[^`]*`(?!`)/.test(content))
    issues.push('Possible shell injection via backtick execution')
  if (/\beval\s*\(/.test(content)) issues.push('Unsafe eval() call')
  if (/\bexec\s*\(/.test(content)) issues.push('Unsafe exec() call')
  if (/\bsystem\s*\(/.test(content)) issues.push('Unsafe system() call')
  if (/\bchild_process\b/.test(content)) issues.push('Direct child_process usage')

  // Credential patterns
  if (/password\s*[=:]\s*["'][^"']+["']/i.test(content)) issues.push('Hardcoded password detected')
  if (/api[_-]?key\s*[=:]\s*["'][^"']+["']/i.test(content))
    issues.push('Hardcoded API key detected')
  if (/\bsecret\s*[=:]\s*["'][^"']+["']/i.test(content)) issues.push('Hardcoded secret detected')
  if (/\bAWS_SECRET/i.test(content)) issues.push('AWS secret reference detected')

  // Unsafe filesystem commands
  if (/rm\s+-rf\s+\/(?!\w)/i.test(content)) issues.push('Dangerous rm -rf / command')
  if (/chmod\s+777/.test(content)) issues.push('Insecure chmod 777')
  if (/>\s*\/etc\//.test(content)) issues.push('Writing to /etc/')

  // Data exfiltration patterns
  if (
    /curl\b.*(?:--data|-d\s)/.test(content) &&
    /curl\b.*https?:\/\/(?!localhost|127\.|10\.|192\.168\.)/.test(content)
  )
    issues.push('Possible data exfiltration via curl')

  return { safe: issues.length === 0, issues }
}
