export async function fetchStatus() {
  return (await fetch("/api/status")).json();
}

export async function fetchHealth() {
  return (await fetch("/health")).json();
}

export async function fetchConfig() {
  return (await fetch("/api/config")).json();
}

export async function saveConfig(config: Record<string, unknown>) {
  return (await fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  })).json();
}

export async function fetchClaudeFiles() {
  return (await fetch("/api/claude-files")).json();
}

export async function saveClaudeFile(name: string, content: string) {
  return (await fetch(`/api/claude-files/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  })).json();
}

export async function fetchSetupStatus(): Promise<{ setupComplete: boolean }> {
  return (await fetch("/api/setup/status")).json();
}

export async function completeSetup(browserTool: string, browserApiKey?: string, composioApiKey?: string) {
  return (await fetch("/api/setup/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ browserTool, browserApiKey, composioApiKey }),
  })).json();
}

export async function fetchSubAgents(): Promise<{ name: string; filename: string; content: string }[]> {
  const data = await (await fetch("/api/sub-agents")).json() as { agents: { name: string; filename: string; content: string }[] };
  return data.agents || [];
}

export async function saveSubAgent(name: string, content: string, ext: "md" | "json" = "md") {
  return (await fetch(`/api/sub-agents/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, ext }),
  })).json();
}

export async function deleteSubAgent(name: string) {
  return (await fetch(`/api/sub-agents/${encodeURIComponent(name)}`, { method: "DELETE" })).json();
}

export function chatWsUrl(sessionId?: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${location.host}/ws/chat`;
  return sessionId ? `${base}?session_id=${sessionId}` : base;
}
