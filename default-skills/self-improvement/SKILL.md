---
name: self-improvement
description: Meta-skill for managing your own learning loop. Guides when and how to create skills, save memories, and build on past experience.
version: 1.0.0
author: Exoclaw
---

# Self-Improvement

## Overview

You have persistent memory and a skills system. Use them to get better over time. This skill guides when and how to save what you learn.

**Core principle:** The most valuable learning prevents the user from having to correct or remind you again.

## When to Save Memory

Save to `~/workspace/MEMORY.md` when you learn:
- **Tool quirks** — a command that needs a specific flag, a library API that's unintuitive
- **Environment facts** — OS details, installed versions, project conventions
- **Stable preferences** — formatting rules, naming conventions, communication style
- **Workflow patterns** — "always run tests before committing", "use pnpm not npm"

Save to `~/workspace/USER.md` when you learn:
- **Who the user is** — role, expertise, what they're working on
- **How they want you to behave** — terse vs detailed, ask vs just do it
- **Personal details** they share — timezone, name, team

### Memory Format

One fact per line. Concise. Will still matter next week.

```markdown
## Tool Quirks
- Project uses pnpm, not npm — `pnpm install` will fail silently with npm
- Tests require `DATABASE_URL` env var even for unit tests

## Preferences
- User prefers single bundled PRs over many small ones for refactors
- Always run `pnpm lint` before committing
```

### When NOT to Save

- Ephemeral task details (current debugging session context)
- Anything derivable from the code or git history
- Obvious things ("TypeScript uses .ts files")

## When to Create Skills

Create a skill in `~/workspace/.claude/skills/<name>/SKILL.md` when:

1. **Trial and error** — you tried multiple approaches before finding one that works
2. **Non-obvious procedure** — the right approach wasn't what you'd guess first
3. **Multi-step workflow** — a sequence of steps that needs to be done in order
4. **User correction** — the user showed you a preferred way of doing something
5. **Repeated task** — you've done this or similar work before

### Skill Format

```markdown
---
name: skill-name
description: One-line description of when to use this skill
version: 1.0.0
---

# Skill Title

## When to Use
[Trigger conditions]

## Procedure
[Step-by-step instructions]

## Gotchas
[Things that can go wrong and how to handle them]
```

### When NOT to Create Skills

- Trivial one-step operations
- One-off tasks unlikely to recur
- Standard library/framework usage documented elsewhere

## When to Update Existing Skills

Update immediately when:
- You use a skill and discover it's **wrong or outdated**
- A step is **missing** that caused you to stumble
- The user corrects you while you're following a skill
- You find a **better approach** than what the skill describes

Don't wait to be asked — patch it immediately.

## Review Cycle

After completing complex tasks (5+ tool calls), pause and ask yourself:

1. **Did I learn something reusable?** → Create or update a skill
2. **Did the user reveal a preference?** → Save to memory
3. **Did I make a mistake I shouldn't repeat?** → Save the lesson
4. **Did I discover a tool quirk?** → Save to memory

The background review system does this automatically every few turns, but you should also do it proactively when you notice something worth saving.

## Progressive Knowledge Building

```
Turn 1:  User says "use pnpm"       → Save to MEMORY.md
Turn 5:  Complex deploy workflow     → Create deploy-procedure skill
Turn 10: User corrects deploy skill  → Update the skill immediately
Turn 20: Skill is now battle-tested  → Others benefit from it too
```

Your value grows with every session. Make it count.
