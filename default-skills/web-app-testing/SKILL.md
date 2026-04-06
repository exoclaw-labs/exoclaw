---
name: web-app-testing
description: Use when testing web applications or dashboards. 5-phase exploratory QA process covering navigation, functionality, error handling, and reporting.
version: 1.0.0
author: Adapted from Hermes Agent dogfood skill
---

# Web Application Testing

## Overview

Systematic exploratory testing for web applications. Navigate every page, test every interaction, document every bug.

**Core principle:** Test like a user, think like an attacker, report like an engineer.

## When to Use

- Testing a new feature or page
- QA pass before release
- When the user asks you to "test this" or "find bugs"
- After making UI changes

## The Five Phases

### Phase 1: Plan

1. Identify all pages/routes to test
2. List key user workflows (signup, login, CRUD, search, etc.)
3. Note the testing environment (URL, credentials, browser)
4. Create a checklist of what to test

### Phase 2: Explore

For each page:
1. Navigate to it — does it load?
2. Check the console for errors (JavaScript errors, failed network requests)
3. Test every interactive element (buttons, forms, links, dropdowns)
4. Test with different inputs (empty, very long, special characters, HTML tags)
5. Test responsive behavior (if applicable)

### Phase 3: Collect Evidence

For each issue found:
- **What happened** — exact steps to reproduce
- **What was expected** — the correct behavior
- **What actually happened** — the incorrect behavior
- **Console errors** — any relevant error messages
- **Severity** — blocker / major / minor / cosmetic

### Phase 4: Categorize

Group issues by:
1. **Functionality** — broken features, incorrect behavior
2. **Security** — XSS, injection, auth bypass, exposed data
3. **Performance** — slow loads, unresponsive UI, memory leaks
4. **UX** — confusing flows, missing feedback, accessibility issues
5. **Visual** — layout breaks, truncation, alignment

De-duplicate: same root cause appearing in different places = one issue.

### Phase 5: Report

```markdown
# QA Report: [App Name] — [Date]

## Summary
- Pages tested: N
- Issues found: N (X blocker, Y major, Z minor)
- Overall assessment: [PASS / CONDITIONAL PASS / FAIL]

## Blockers
1. [Page] — [Description] — Steps: ...

## Major Issues
1. [Page] — [Description] — Steps: ...

## Minor Issues
1. [Page] — [Description] — Steps: ...

## Tested & Passing
- [List of features/pages that work correctly]
```

## Common Things to Test

### Forms
- Submit empty form — proper validation messages?
- Submit with invalid data — proper error messages?
- Submit with valid data — correct behavior?
- Double-submit — handled gracefully?

### Authentication
- Login with wrong credentials — clear error message?
- Session timeout — handled properly?
- Protected pages — redirect to login?

### Error Handling
- 404 pages — friendly error page?
- Network offline — graceful degradation?
- Server errors — user-friendly message?

### Edge Cases
- Very long text input — truncated properly?
- Special characters (`<script>`, `'; DROP TABLE`, `../`) — sanitized?
- Empty states — helpful message when no data?
- Back button — correct behavior?

## Remember

- Test the unhappy paths, not just the happy paths
- Document everything, even if it seems minor
- Re-test after fixes to confirm resolution
- Check the browser console on every page
