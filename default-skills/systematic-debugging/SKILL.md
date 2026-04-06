---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior. 4-phase root cause investigation — NO fixes without understanding the problem first.
version: 1.0.0
author: Adapted from Hermes Agent / obra/superpowers
---

# Systematic Debugging

## Overview

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## When to Use

Use for ANY technical issue:
- Test failures or build errors
- Bugs or unexpected behavior
- Performance problems
- Integration issues
- Configuration problems

**Especially when:** under time pressure, "just one quick fix" seems obvious, or you've already tried multiple fixes.

## Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

### 1. Read Error Messages Carefully
- Read stack traces completely — they often contain the exact solution
- Note line numbers, file paths, error codes
- Read the FULL error, not just the first line

### 2. Reproduce Consistently
- Can you trigger it reliably? What are the exact steps?
- If not reproducible, gather more data — don't guess

### 3. Check Recent Changes
```bash
git log --oneline -10
git diff
git log -p --follow path/to/problematic_file | head -100
```

### 4. Gather Evidence in Multi-Component Systems
For each component boundary:
- Log what data enters and exits
- Verify environment/config propagation
- Run once to gather evidence showing WHERE it breaks
- THEN analyze to identify the failing component

### 5. Trace Data Flow
- Where does the bad value originate?
- What called this function with the bad value?
- Keep tracing upstream until you find the source
- Fix at the source, not at the symptom

### Phase 1 Checklist
- [ ] Error messages fully read and understood
- [ ] Issue reproduced consistently
- [ ] Recent changes reviewed
- [ ] Evidence gathered
- [ ] Root cause hypothesis formed

**STOP:** Do not proceed to Phase 2 until you understand WHY it's happening.

## Phase 2: Pattern Analysis

1. **Find working examples** — locate similar working code in the codebase
2. **Compare against references** — read reference implementations completely, not skimming
3. **Identify differences** — what's different between working and broken?
4. **Understand dependencies** — what other components, settings, or config does this need?

## Phase 3: Hypothesis and Testing

1. **Form a single hypothesis** — "I think X is the root cause because Y"
2. **Test minimally** — make the SMALLEST possible change to test the hypothesis
3. **One variable at a time** — don't fix multiple things at once
4. **Verify** — did it work? If not, form a NEW hypothesis. Don't stack fixes.

## Phase 4: Implementation

1. **Create failing test case** — simplest possible reproduction, automated if possible
2. **Implement single fix** — address root cause only, ONE change at a time
3. **Verify fix** — run the regression test, then full suite for no regressions
4. **Rule of Three** — if 3+ fixes have failed, STOP and question the architecture. This is NOT a failed hypothesis — it's likely a wrong architecture. Discuss before attempting more.

## Red Flags — STOP and Return to Phase 1

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- Proposing solutions before tracing data flow

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, trace data | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare, identify differences | Know what's different |
| **3. Hypothesis** | Form theory, test minimally, one variable at a time | Confirmed or new hypothesis |
| **4. Implementation** | Create test, fix root cause, verify | Bug resolved, all tests pass |

**No shortcuts. No guessing. Systematic always wins.**
