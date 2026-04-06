---
name: code-review
description: Use before committing code changes. Systematic quality check covering correctness, security, performance, and style.
version: 1.0.0
author: Adapted from Hermes Agent
---

# Code Review

## Overview

Review code changes before they're committed. Catch bugs, security issues, and design problems early.

**Core principle:** Review your own work as critically as you'd review someone else's.

## When to Use

- Before committing any non-trivial code change
- After implementing a feature or fix
- When the user asks for a review of their code or a PR

## Review Checklist

### 1. Correctness

- [ ] Does the code do what it's supposed to?
- [ ] Are edge cases handled? (null, empty, boundary values)
- [ ] Are error paths handled? (network failures, invalid input)
- [ ] Does it match the requirements/spec?

### 2. Security (OWASP Top 10)

- [ ] No command injection (user input in shell commands)
- [ ] No SQL injection (user input in queries)
- [ ] No XSS (user input rendered as HTML)
- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] No path traversal (user input in file paths)
- [ ] Proper input validation at system boundaries

### 3. Performance

- [ ] No unnecessary loops or repeated work
- [ ] No N+1 query patterns
- [ ] No blocking operations in async contexts
- [ ] Reasonable memory usage (no unbounded growth)

### 4. Design

- [ ] Single responsibility — each function does one thing
- [ ] No premature abstractions (three similar lines > one premature abstraction)
- [ ] No speculative features (YAGNI)
- [ ] Clear naming that reveals intent
- [ ] Minimal public surface area

### 5. Testing

- [ ] Tests exist for new functionality
- [ ] Tests cover the happy path AND edge cases
- [ ] Tests are deterministic (no flaky tests)
- [ ] Test names describe the behavior being tested

## How to Review a Diff

```bash
# See what changed
git diff --stat
git diff

# For PR reviews
git log main..HEAD --oneline
git diff main...HEAD
```

### Review Strategy

1. **Read the diff summary first** — understand scope and which files changed
2. **Read tests first** — understand intended behavior before reading implementation
3. **Read implementation** — check against the test expectations
4. **Check for missing tests** — what behaviors aren't tested?
5. **Check for regressions** — run the full test suite

## Severity Levels

| Level | Action | Examples |
|-------|--------|---------|
| **Blocker** | Must fix before merge | Security vulnerability, data loss, crash |
| **Major** | Should fix before merge | Incorrect behavior, missing error handling |
| **Minor** | Fix if easy, otherwise note | Style inconsistency, non-critical optimization |
| **Nit** | Optional, low priority | Naming preference, comment wording |

## Output Format

When reporting findings:

```markdown
## Review: [feature/change name]

### Summary
[1-2 sentences on overall quality]

### Findings

**[BLOCKER]** src/auth.ts:42 — SQL injection via unsanitized user input
**[MAJOR]** src/api.ts:15 — Missing error handler for network timeout
**[MINOR]** src/utils.ts:8 — Function name `doThing` doesn't describe behavior

### Verdict
[APPROVE / REQUEST CHANGES / NEEDS DISCUSSION]
```

## Remember

- Be specific — cite file and line number
- Explain WHY something is a problem, not just WHAT
- Suggest fixes, don't just point out problems
- Distinguish blockers from nits — not everything is critical
