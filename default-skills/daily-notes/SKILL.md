---
name: daily-notes
description: Use daily notes (memory/YYYY-MM-DD.md) to maintain temporal context across sessions. Write observations, decisions, and progress throughout the day.
version: 1.0.0
author: Exoclaw
---

# Daily Notes

## Overview

You keep daily notes in `~/workspace/memory/YYYY-MM-DD.md` files. These provide temporal context — what happened today and yesterday is automatically loaded so you remember recent work.

**Core principle:** Write notes as you go. Tomorrow's you will thank today's you.

## When to Write

Write to today's daily note whenever:
- You complete a significant task or milestone
- The user makes a decision worth remembering tomorrow
- You discover something non-obvious about the environment
- You encounter an error and figure out the solution
- The user shares context about upcoming work
- A multi-step task is in progress and you need to track state

## Format

```markdown
## Morning
- Started working on X feature
- User mentioned deadline is Friday

## Afternoon  
- Completed X feature, PR created
- Discovered that the test DB needs REDIS_URL set
- User prefers deploying to staging before main

## Notes
- The CI pipeline takes ~8 minutes
- Deploy script is at scripts/deploy.sh (not in PATH)
```

## What NOT to Write

- Verbatim conversation transcripts (too noisy)
- Code snippets (they're in the repo)
- Information already in MEMORY.md (long-term facts go there)

## Daily Notes vs MEMORY.md

| Daily Notes | MEMORY.md |
|-------------|-----------|
| Temporal — what happened today | Durable — facts that last indefinitely |
| Progress, decisions, observations | Preferences, tool quirks, conventions |
| Auto-pruned after 90 days | Kept forever |
| Write frequently throughout the day | Write only when you learn something permanent |

## The Dreaming Process

A background job runs nightly to review recent daily notes and promote high-signal items to MEMORY.md. This means your daily notes naturally feed into long-term memory — you don't need to manually move things.
