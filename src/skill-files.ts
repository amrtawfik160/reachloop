import commands from '../skills/reachloop/reference/commands.md' with { type: 'text' };
import modes from '../skills/reachloop/reference/modes-and-limits.md' with { type: 'text' };
import skill from '../skills/reachloop/SKILL.md' with { type: 'text' };

export const SKILL_FILES: Record<string, string> = {
  'SKILL.md': skill,
  'reference/commands.md': commands,
  'reference/modes-and-limits.md': modes,
};
