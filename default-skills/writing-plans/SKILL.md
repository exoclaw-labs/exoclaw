---
name: writing-plans
description: Use when you have requirements for a multi-step task. Creates comprehensive implementation plans with bite-sized tasks, exact file paths, and complete code examples.
version: 1.0.0
author: Adapted from Hermes Agent / obra/superpowers
---

# Writing Implementation Plans

## Overview

Write comprehensive implementation plans assuming the implementer has zero codebase context. Document everything: which files to touch, complete code, testing commands, how to verify. Give them bite-sized tasks.

**Core principle:** A good plan makes implementation obvious. If someone has to guess, the plan is incomplete.

## When to Use

- Before implementing multi-step features
- When breaking down complex requirements
- Before delegating work (to subagents or future sessions)

## Bite-Sized Task Granularity

**Each task = 2-5 minutes of focused work.**

Every step is one action:
- "Write the failing test" — step
- "Run it to confirm it fails" — step
- "Implement the minimal code" — step
- "Run tests to confirm pass" — step
- "Commit" — step

**Too big:** "Build authentication system" (50 lines across 5 files)
**Right size:** "Create User model with email field" (10 lines, 1 file)

## Plan Document Structure

### Header

```markdown
# [Feature Name] Implementation Plan

**Goal:** [One sentence describing what this builds]
**Architecture:** [2-3 sentences about approach]
**Tech Stack:** [Key technologies/libraries]
```

### Task Format

```markdown
### Task N: [Descriptive Name]

**Objective:** What this task accomplishes

**Files:**
- Create: `exact/path/to/new_file.ts`
- Modify: `exact/path/to/existing.ts`
- Test: `tests/path/to/test_file.ts`

**Step 1:** Write failing test
**Step 2:** Run test to verify failure
**Step 3:** Write minimal implementation
**Step 4:** Run test to verify pass
**Step 5:** Commit
```

## Writing Process

1. **Understand requirements** — read specs, constraints, acceptance criteria
2. **Explore codebase** — understand project structure and similar features
3. **Design approach** — architecture, file organization, testing strategy
4. **Write tasks** — setup, core functionality (TDD each), edge cases, integration, cleanup
5. **Add complete details** — exact paths, complete code, exact commands, expected output
6. **Review** — sequential, bite-sized, exact paths, complete code, no missing context

## Principles

- **DRY** — extract shared logic, don't copy-paste
- **YAGNI** — implement only what's needed now, no speculative abstractions
- **TDD** — every task producing code includes the full test cycle
- **Frequent commits** — commit after every task

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Vague tasks ("Add auth") | Specific ("Create User model with email and password_hash") |
| Incomplete code ("Add validation") | Complete copy-pasteable code with the actual function |
| Missing verification ("Test it works") | Exact command with expected output |
| Missing file paths ("Create the model") | Exact path (`src/models/user.ts`) |

## Remember

```
Bite-sized tasks (2-5 min each)
Exact file paths
Complete code (copy-pasteable)
Exact commands with expected output
Verification steps
DRY, YAGNI, TDD
Frequent commits
```

**A good plan makes implementation obvious.**
