---
name: browser-automation
description: Use when you need to browse the web, interact with web pages, take screenshots, fill forms, or extract data from websites. Uses agent-browser via MCP tools.
version: 1.1.0
author: Exoclaw
---

# Browser Automation (agent-browser)

## Overview

You have a browser available via the `agent-browser` MCP server. It supports both cloud browsers (Browserbase, Browser Use, etc.) and local Chrome.

**Cloud browsers are preferred** — they're faster to start, don't need local Chrome, and work out of the box. Local Chrome can be installed on-demand via the install script if needed.

**Core principle:** Use semantic element references (`@e1`, `@e2`) from snapshots — never guess at CSS selectors.

## When to Use

- Browsing documentation or web pages
- Testing web applications
- Filling out forms or clicking buttons
- Taking screenshots for the user
- Extracting structured data from websites
- Checking if a deployed site is working
- Debugging frontend issues

## Basic Workflow

Every browser interaction follows this pattern:

1. **Navigate** — open a URL
2. **Snapshot** — get the page's interactive elements with references
3. **Interact** — click, fill, scroll using element references
4. **Verify** — snapshot again or take a screenshot to confirm

## Key Commands

### Navigation

```
navigate(url: "https://example.com")
go_back()
go_forward()
reload()
```

### Discovering Elements

```
snapshot()
```

This returns the page's accessibility tree with element references like `@e1`, `@e2`, etc. Each element shows its role (button, link, input), label, and current state.

**Always snapshot before interacting.** Element references change between snapshots.

### Interaction

```
click(ref: "@e1")                    # Click an element
fill(ref: "@e2", value: "hello")     # Fill an input field
type(text: "search query")           # Type text (keyboard)
hover(ref: "@e3")                    # Hover over element
select(ref: "@e4", value: "option")  # Select dropdown option
check(ref: "@e5")                    # Check a checkbox
uncheck(ref: "@e5")                  # Uncheck a checkbox
scroll(direction: "down")            # Scroll the page
```

### Data Extraction

```
get_text(ref: "@e1")          # Get text content of an element
get_html(ref: "@e1")          # Get HTML of an element
get_attribute(ref: "@e1", name: "href")  # Get a specific attribute
screenshot()                   # Take a full page screenshot
```

### JavaScript

```
evaluate(script: "document.title")
evaluate(script: "document.querySelectorAll('a').length")
```

## Example: Search and Extract

```
1. navigate(url: "https://example.com")
2. snapshot()                          # Find the search input → @e3
3. fill(ref: "@e3", value: "query")
4. click(ref: "@e4")                   # Click search button
5. snapshot()                          # See results
6. get_text(ref: "@e7")               # Extract result text
```

## Example: Form Submission

```
1. navigate(url: "https://app.example.com/signup")
2. snapshot()                          # Discover form fields
3. fill(ref: "@e2", value: "user@example.com")
4. fill(ref: "@e3", value: "password123")
5. click(ref: "@e5")                   # Submit button
6. snapshot()                          # Verify success/error state
```

## Tips

- **Always snapshot first** — don't guess at element references
- **Element refs are ephemeral** — they change after navigation or page updates; re-snapshot after interactions
- **Use screenshots for visual verification** — when you need to confirm layout, styling, or visual state
- **Batch related actions** — navigate + snapshot in sequence for efficiency
- **Handle loading** — after clicks that trigger navigation, wait briefly then snapshot
- **Forms**: use `fill` for inputs, `select` for dropdowns, `check`/`uncheck` for checkboxes

## Limitations

- Browser runs headless in the container — no visual display
- Some sites may block automated browsers (CAPTCHA, bot detection)
- Heavy SPAs may need time to render — re-snapshot if elements seem missing
- File downloads go to the workspace directory
