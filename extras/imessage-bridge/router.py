#!/usr/bin/env python3
"""
iMessage Router — routes messages between iMessage contacts and exoclaw containers.

Runs on the Mac host. Polls ~/Library/Messages/chat.db for new messages,
routes them to the correct container based on a contact-to-container mapping,
and sends replies back via the MCP tool.

Multi-container routing logic:
  1. Each container has an "approved contacts" list in the routing config
  2. When a message arrives, find which container owns that contact
  3. POST to that container's webhook
  4. Send the reply back to the sender via MCP tool_send_message

  For agent-initiated messages:
  1. Agent calls tool_send_message via MCP (goes through mac-messages-mcp)
  2. Watcher sees the outbound in chat.db (is_from_me=True) — ignores it
  3. When the human replies, watcher routes to the container that last
     messaged that contact (tracked in active_conversations)

Config (router-config.json):
{
  "containers": {
    "greg": {
      "webhook": "http://localhost:8081/webhook",
      "contacts": ["+1555123456", "user@icloud.com"]
    },
    "linda": {
      "webhook": "http://localhost:8082/webhook",
      "contacts": ["+1555789012"]
    }
  },
  "mcp_url": "http://localhost:8010",
  "poll_interval": 3,
  "default_container": "greg"
}
"""

import json
import os
import time
import urllib.request
import sys
from pathlib import Path

# ── Config ──

CONFIG_PATH = os.environ.get("ROUTER_CONFIG", str(Path(__file__).parent / "router-config.json"))
CHAT_DB = os.path.expanduser("~/Library/Messages/chat.db")
POLL_INTERVAL = 3
MCP_URL = "http://localhost:8010"

def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)

# ── Contact → Container mapping ──

def build_routing_table(config):
    """Build sender -> container mapping from config."""
    table = {}  # normalized_contact -> container_name
    for name, container in config.get("containers", {}).items():
        for contact in container.get("contacts", []):
            table[normalize_contact(contact)] = name
    return table

def normalize_contact(s):
    """Normalize phone numbers and emails for matching."""
    s = s.strip().lower()
    # Strip non-digit for phone numbers
    if s.startswith("+") or s[0:1].isdigit():
        return "".join(c for c in s if c.isdigit())
    return s

# ── Active conversations (for agent-initiated messages) ──
# When a container sends a message to a new contact, track it here
# so replies route back to that container.
active_conversations = {}  # normalized_contact -> container_name

# ── Database (via sqlite3 CLI to avoid python TCC issues) ──

def query_db(sql):
    """Run a SQL query via the sqlite3 CLI."""
    import subprocess
    result = subprocess.run(
        ["/usr/bin/sqlite3", "-separator", "\t", CHAT_DB, sql],
        capture_output=True, text=True, timeout=10
    )
    if result.returncode != 0:
        raise RuntimeError(f"sqlite3 error: {result.stderr.strip()}")
    rows = []
    for line in result.stdout.strip().split("\n"):
        if line:
            rows.append(line.split("\t"))
    return rows

def get_max_rowid():
    rows = query_db("SELECT MAX(ROWID) FROM message;")
    return int(rows[0][0]) if rows and rows[0][0] else 0

def get_new_messages(last_rowid):
    sql = f"""
        SELECT m.ROWID, m.text, h.id, m.is_from_me, m.service, m.cache_roomnames
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.ROWID > {last_rowid} AND m.text IS NOT NULL AND m.text != ''
        ORDER BY m.ROWID ASC;
    """
    rows = query_db(sql)
    result = []
    for r in rows:
        result.append((
            int(r[0]),           # rowid
            r[1],                # text
            r[2] if r[2] else None,  # sender
            r[3] == "1",         # is_from_me
            r[4],                # service
            r[5] if len(r) > 5 and r[5] else None,  # group
        ))
    return result

# ── Webhook ──

def post_webhook(url, message, sender, timeout=120):
    """POST to container webhook, return response text."""
    payload = json.dumps({"message": message}).encode()
    headers = {"Content-Type": "application/json"}
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
            return data.get("response", "")
    except Exception as e:
        log(f"Webhook error ({url}): {e}")
        return None

# ── MCP Send ──

def send_imessage(recipient, message, mcp_url):
    """Send a message via the MCP tool_send_message."""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "tool_send_message",
            "arguments": {"recipient": recipient, "message": message}
        }
    }).encode()
    headers = {"Content-Type": "application/json"}
    req = urllib.request.Request(mcp_url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except Exception as e:
        log(f"MCP send error: {e}")
        return None

# ── Self-handle detection ──

def detect_self_handles():
    """Find handles that are 'me' (outbound messages)."""
    handles = set()
    rows = query_db("""
        SELECT DISTINCT h.id FROM message m
        JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.is_from_me = 1
        LIMIT 50;
    """)
    for row in rows:
        handles.add(normalize_contact(row[0]))
    return handles

# ── Main loop ──

def main():
    log("iMessage Router starting")

    config = load_config()
    mcp_url = config.get("mcp_url", MCP_URL)
    poll_interval = config.get("poll_interval", POLL_INTERVAL)
    default_container = config.get("default_container")
    routing_table = build_routing_table(config)
    containers = config.get("containers", {})

    log(f"Routing table: {len(routing_table)} contacts -> {len(containers)} containers")
    for contact, name in routing_table.items():
        log(f"  {contact} -> {name}")

    last_rowid = get_max_rowid()
    self_handles = detect_self_handles()
    log(f"Starting from ROWID {last_rowid}, {len(self_handles)} self handles")

    while True:
        try:
            messages = get_new_messages(last_rowid)
            for rowid, text, sender, is_from_me, service, group in messages:
                last_rowid = rowid

                if is_from_me:
                    continue
                if not sender or not text:
                    continue

                norm_sender = normalize_contact(sender)

                # Find which container handles this contact
                container_name = (
                    routing_table.get(norm_sender) or
                    active_conversations.get(norm_sender) or
                    default_container
                )

                if not container_name or container_name not in containers:
                    log(f"No container for {sender}, skipping")
                    continue

                container = containers[container_name]
                webhook_url = container["webhook"]

                # Format message with context
                if group:
                    context = f"[iMessage from {sender} in group {group}]: {text}"
                else:
                    context = f"[iMessage from {sender}]: {text}"

                log(f"{sender} -> {container_name}: {text[:80]}")

                # Post to container webhook
                response = post_webhook(webhook_url, context, sender)

                if response:
                    # Track this conversation for future routing
                    active_conversations[norm_sender] = container_name
                    # Send reply back via MCP
                    send_imessage(sender, response, mcp_url)
                    log(f"{container_name} -> {sender}: {response[:80]}")

        except RuntimeError as e:
            log(f"DB error (will retry): {e}")
        except Exception as e:
            log(f"Error: {e}")

        time.sleep(poll_interval)

def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)

if __name__ == "__main__":
    main()
