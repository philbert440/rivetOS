/**
 * Skill system types.
 *
 * Skills are directories containing a SKILL.md file with specialized
 * instructions. When a task matches a skill, the agent reads the
 * SKILL.md and follows it.
 */

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export interface Skill {
  /** Skill name (directory name or frontmatter override) */
  name: string
  /** Human-readable description of what this skill does */
  description: string
  /** Absolute path to the SKILL.md file */
  location: string
  /** Keywords/patterns that activate this skill */
  triggers?: string[]
  /** Skill version from frontmatter (default: 1) */
  version?: number
  /** Category for organizing skills */
  category?: string
  /** Comma-separated tags */
  tags?: string[]
}

// ---------------------------------------------------------------------------
// Skill Manager Interface
// ---------------------------------------------------------------------------

export interface SkillManager {
  /**
   * Scan directories for subdirectories containing SKILL.md.
   * Parses frontmatter for name, description, and triggers.
   * Returns all discovered skills.
   */
  discover(skillDirs: string[]): Promise<Skill[]>

  /**
   * Load and return the full SKILL.md content for a given skill name.
   */
  load(skillName: string): Promise<string>

  /**
   * Given a user message, find the best matching skill by
   * keyword/trigger matching. Returns null if no skill matches.
   */
  match(query: string): Skill | null

  /** Return all discovered skills. */
  list(): Skill[]

  /**
   * Re-scan a single skill directory after create/edit/delete.
   * Clears skills from this directory and re-discovers them.
   */
  rediscover(skillDir: string): Promise<void>

  /** Get the configured skill directories */
  getSkillDirs(): string[]
}
