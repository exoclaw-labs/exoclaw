// ── Token management ──

const TOKEN_KEY = "exoclaw-api-token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// Callback invoked when any API call gets a 401. Set by App.vue to show
// the login prompt without coupling useApi to Vue reactivity.
let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(cb: () => void) {
  onUnauthorized = cb;
}

/** Fetch wrapper that attaches the Bearer token and fires onUnauthorized on 401. */
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("content-type") && init?.body) headers.set("content-type", "application/json");

  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) onUnauthorized?.();
  return res;
}

// ── API functions ──

export async function fetchStatus() {
  return (await apiFetch("/api/status")).json();
}

export async function fetchConfig() {
  return (await apiFetch("/api/config")).json();
}

export async function saveConfig(config: Record<string, unknown>) {
  return (await apiFetch("/api/config", {
    method: "PUT",
    body: JSON.stringify(config),
  })).json();
}

export async function fetchClaudeFiles() {
  return (await apiFetch("/api/claude-files")).json();
}

export async function saveClaudeFile(name: string, content: string) {
  return (await apiFetch(`/api/claude-files/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  })).json();
}

export async function fetchSetupStatus(): Promise<{ setupComplete: boolean }> {
  return (await apiFetch("/api/setup/status")).json();
}

export async function completeSetup(browserTool: string, browserApiKey?: string, composioApiKey?: string) {
  return (await apiFetch("/api/setup/complete", {
    method: "POST",
    body: JSON.stringify({ browserTool, browserApiKey, composioApiKey }),
  })).json();
}

export interface SubAgent { name: string; files: Record<string, string> }

export async function fetchSubAgents(): Promise<SubAgent[]> {
  const data = await (await apiFetch("/api/sub-agents")).json() as { agents: SubAgent[] };
  return data.agents || [];
}

export async function saveSubAgentFile(agentName: string, file: string, content: string) {
  return (await apiFetch(`/api/sub-agents/${encodeURIComponent(agentName)}/${encodeURIComponent(file)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  })).json();
}

export async function deleteSubAgent(name: string) {
  return (await apiFetch(`/api/sub-agents/${encodeURIComponent(name)}`, { method: "DELETE" })).json();
}

export async function deleteSubAgentFile(agentName: string, file: string) {
  return (await apiFetch(`/api/sub-agents/${encodeURIComponent(agentName)}/${encodeURIComponent(file)}`, { method: "DELETE" })).json();
}

// ── Logs ──

export interface LogUnitSummary {
  unit: string;
  size: number;
  mtime: string;
  rotated: number[];
}

export interface LogListResponse {
  logDir: string;
  units: LogUnitSummary[];
}

export interface LogReadResponse {
  unit: string;
  rotated: number;
  size: number;
  mtime: string;
  truncated: boolean;
  lines: string[];
}

export async function fetchLogList(): Promise<LogListResponse> {
  return (await apiFetch("/api/logs")).json();
}

export async function fetchLog(unit: string, opts: { rotated?: number; tail?: number } = {}): Promise<LogReadResponse> {
  const qs = new URLSearchParams();
  if (opts.rotated) qs.set("rotated", String(opts.rotated));
  if (opts.tail) qs.set("tail", String(opts.tail));
  const q = qs.toString();
  return (await apiFetch(`/api/logs/${encodeURIComponent(unit)}${q ? "?" + q : ""}`)).json();
}
