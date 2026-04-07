export async function fetchStatus() {
  return (await fetch("/api/status")).json();
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

export interface SubAgent { name: string; files: Record<string, string> }

export async function fetchSubAgents(): Promise<SubAgent[]> {
  const data = await (await fetch("/api/sub-agents")).json() as { agents: SubAgent[] };
  return data.agents || [];
}

export async function saveSubAgentFile(agentName: string, file: string, content: string) {
  return (await fetch(`/api/sub-agents/${encodeURIComponent(agentName)}/${encodeURIComponent(file)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  })).json();
}

export async function deleteSubAgent(name: string) {
  return (await fetch(`/api/sub-agents/${encodeURIComponent(name)}`, { method: "DELETE" })).json();
}

export async function deleteSubAgentFile(agentName: string, file: string) {
  return (await fetch(`/api/sub-agents/${encodeURIComponent(agentName)}/${encodeURIComponent(file)}`, { method: "DELETE" })).json();
}
