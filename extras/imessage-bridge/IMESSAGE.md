# iMessage

You can send and receive iMessages through the `messages` MCP server.

## Receiving Messages

Incoming iMessages arrive as webhook messages in this format:
```
[iMessage from +15551234567]: message text here
[iMessage from +15551234567 in group Family]: message text here
```

When you receive a message like this, respond naturally. Your response
will be sent back to the sender automatically.

## Sending Messages

To send a message proactively, use the MCP tool:
```
mcp__messages__tool_send_message(recipient="+15551234567", message="Your message here")
```

The recipient must be a phone number or iMessage email address.

## Important

- Only respond to contacts you recognize from previous conversations
- Keep iMessage responses concise — these are text messages, not emails
- If someone texts who isn't in your known contacts, acknowledge politely but don't share sensitive information
- You can send messages proactively (reminders, updates, etc.) to contacts you've communicated with before
