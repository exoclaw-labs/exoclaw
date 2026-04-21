import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let TEST_HOME: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  vi.resetModules();
  TEST_HOME = join(
    tmpdir(),
    `exoclaw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.HOME = TEST_HOME;
  mkdirSync(join(TEST_HOME, ".exoclaw"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── YAML !secret tag ──

describe("YAML !secret tag", () => {
  it("parseYaml produces SecretValue for !secret tagged values", async () => {
    const { parseYaml, SecretValue } = await import("./config-store.js");
    const result = parseYaml("apiToken: !secret my-secret-token\nname: agent\n");
    expect(result.apiToken).toBeInstanceOf(SecretValue);
    expect(result.apiToken.value).toBe("my-secret-token");
    expect(result.name).toBe("agent");
  });

  it("stringifyYaml writes !secret tags for SecretValue instances", async () => {
    const { stringifyYaml, SecretValue } = await import("./config-store.js");
    const yaml = stringifyYaml({
      name: "agent",
      apiToken: new SecretValue("my-secret"),
    });
    expect(yaml).toContain("!secret");
    expect(yaml).toContain("my-secret");
    expect(yaml).toContain("name: agent");
  });

  it("round-trip preserves SecretValue and plain values", async () => {
    const { parseYaml, stringifyYaml, SecretValue } = await import("./config-store.js");
    const original = {
      name: "test-agent",
      port: 8080,
      apiToken: new SecretValue("tok-123"),
      channels: {
        slack: {
          enabled: true,
          botToken: new SecretValue("xoxb-abc"),
        },
      },
    };

    const yaml = stringifyYaml(original);
    const parsed = parseYaml(yaml);

    expect(parsed.name).toBe("test-agent");
    expect(parsed.port).toBe(8080);
    expect(parsed.apiToken).toBeInstanceOf(SecretValue);
    expect(parsed.apiToken.value).toBe("tok-123");
    expect(parsed.channels.slack.enabled).toBe(true);
    expect(parsed.channels.slack.botToken).toBeInstanceOf(SecretValue);
    expect(parsed.channels.slack.botToken.value).toBe("xoxb-abc");
  });

  it("parseYaml returns empty object for empty input", async () => {
    const { parseYaml } = await import("./config-store.js");
    expect(parseYaml("")).toEqual({});
  });

  it("SecretValue.toString() returns the underlying value", async () => {
    const { SecretValue } = await import("./config-store.js");
    const sv = new SecretValue("hello");
    expect(sv.toString()).toBe("hello");
    expect(`${sv}`).toBe("hello");
  });

  it("SecretValue.toJSON() returns the underlying value", async () => {
    const { SecretValue } = await import("./config-store.js");
    const sv = new SecretValue("hello");
    expect(JSON.stringify({ key: sv })).toBe('{"key":"hello"}');
  });
});

// ── resolveSecrets ──

describe("resolveSecrets", () => {
  it("replaces SecretValue with plain strings", async () => {
    const { resolveSecrets, SecretValue } = await import("./config-store.js");
    const result = resolveSecrets({
      apiToken: new SecretValue("tok-123"),
      name: "agent",
    });
    expect(result.apiToken).toBe("tok-123");
    expect(result.name).toBe("agent");
  });

  it("resolves nested SecretValues", async () => {
    const { resolveSecrets, SecretValue } = await import("./config-store.js");
    const result = resolveSecrets({
      channels: {
        slack: { botToken: new SecretValue("xoxb-abc") },
      },
    });
    expect(result.channels.slack.botToken).toBe("xoxb-abc");
  });

  it("resolves SecretValues in arrays", async () => {
    const { resolveSecrets, SecretValue } = await import("./config-store.js");
    const result = resolveSecrets({
      items: [new SecretValue("a"), "b", { key: new SecretValue("c") }],
    });
    expect(result.items).toEqual(["a", "b", { key: "c" }]);
  });

  it("handles plain objects without SecretValues", async () => {
    const { resolveSecrets } = await import("./config-store.js");
    const input = { name: "agent", port: 8080, nested: { enabled: true } };
    const result = resolveSecrets(input);
    expect(result).toEqual(input);
  });
});

// ── trackSecretPaths ──

describe("trackSecretPaths", () => {
  it("returns dot-notation paths of all SecretValue fields", async () => {
    const { trackSecretPaths, SecretValue } = await import("./config-store.js");
    const paths = trackSecretPaths({
      apiToken: new SecretValue("tok"),
      name: "agent",
      channels: {
        slack: {
          botToken: new SecretValue("xoxb"),
          enabled: true,
        },
      },
    });
    expect(paths).toContain("apiToken");
    expect(paths).toContain("channels.slack.botToken");
    expect(paths).toHaveLength(2);
  });

  it("returns empty array for object with no secrets", async () => {
    const { trackSecretPaths } = await import("./config-store.js");
    const paths = trackSecretPaths({ name: "agent", port: 8080 });
    expect(paths).toEqual([]);
  });

  it("uses prefix for nested calls", async () => {
    const { trackSecretPaths, SecretValue } = await import("./config-store.js");
    const paths = trackSecretPaths({ key: new SecretValue("val") }, "root.sub");
    expect(paths).toEqual(["root.sub.key"]);
  });
});

// ── retagSecrets ──

describe("retagSecrets", () => {
  it("wraps values at known secretPaths with SecretValue", async () => {
    const { retagSecrets, SecretValue } = await import("./config-store.js");
    const result = retagSecrets(
      { myCustomField: "secret-val", name: "agent" },
      new Set(["myCustomField"]),
    );
    expect(result.myCustomField).toBeInstanceOf(SecretValue);
    expect(result.myCustomField.value).toBe("secret-val");
    expect(result.name).toBe("agent");
  });

  it("auto-tags fields matching SECRET_FIELD_HINTS", async () => {
    const { retagSecrets, SecretValue } = await import("./config-store.js");
    const result = retagSecrets(
      { apiToken: "tok-123", botToken: "xoxb-abc", name: "agent" },
      new Set(),
    );
    expect(result.apiToken).toBeInstanceOf(SecretValue);
    expect(result.apiToken.value).toBe("tok-123");
    expect(result.botToken).toBeInstanceOf(SecretValue);
    expect(result.botToken.value).toBe("xoxb-abc");
    expect(result.name).toBe("agent");
  });

  it("recurses into nested objects", async () => {
    const { retagSecrets, SecretValue } = await import("./config-store.js");
    const result = retagSecrets(
      { channels: { slack: { botToken: "xoxb-def", enabled: true } } },
      new Set(),
    );
    expect(result.channels.slack.botToken).toBeInstanceOf(SecretValue);
    expect(result.channels.slack.botToken.value).toBe("xoxb-def");
    expect(result.channels.slack.enabled).toBe(true);
  });

  it("tags fields by both path and field name", async () => {
    const { retagSecrets, SecretValue } = await import("./config-store.js");
    const result = retagSecrets(
      { customPath: "val1", apiToken: "val2" },
      new Set(["customPath"]),
    );
    // customPath matched by explicit path, apiToken by SECRET_FIELD_HINTS
    expect(result.customPath).toBeInstanceOf(SecretValue);
    expect(result.apiToken).toBeInstanceOf(SecretValue);
  });

  it("does not tag non-string values", async () => {
    const { retagSecrets } = await import("./config-store.js");
    const result = retagSecrets(
      { port: 8080, enabled: true },
      new Set(["port"]),
    );
    // port is a number, not a string, so it should not be wrapped
    expect(result.port).toBe(8080);
    expect(result.enabled).toBe(true);
  });
});

// ── loadConfig from YAML ──

describe("loadConfig from YAML", () => {
  it("reads config.yml and resolves secrets to plain strings", async () => {
    const { SecretValue, stringifyYaml } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");
    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({
        name: "test-agent",
        port: 3000,
        apiToken: new SecretValue("my-token"),
        session: {
          provider: "claude",
          model: "claude-sonnet-4-6",
          providers: { claude: {} },
        },
      }),
    );

    // Re-import to pick up the written file
    vi.resetModules();
    const { loadConfig } = await import("./config-store.js");
    const config = loadConfig();

    expect(config.name).toBe("test-agent");
    expect(config.port).toBe(3000);
    expect(config.apiToken).toBe("my-token");
    expect(typeof config.apiToken).toBe("string");
  });

  it("applies EXOCLAW_API_TOKEN env overlay", async () => {
    const { SecretValue, stringifyYaml } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");
    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({
        name: "test-agent",
        apiToken: new SecretValue("disk-token"),
      }),
    );

    process.env.EXOCLAW_API_TOKEN = "env-token";
    vi.resetModules();
    const { loadConfig } = await import("./config-store.js");
    const config = loadConfig();

    expect(config.apiToken).toBe("env-token");
    delete process.env.EXOCLAW_API_TOKEN;
  });

  it("applies EXOCLAW_PEERS env overlay", async () => {
    const { SecretValue, stringifyYaml } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");
    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({
        name: "test-agent",
        peers: { existing: { url: "http://a" } },
      }),
    );

    process.env.EXOCLAW_PEERS = JSON.stringify({ newPeer: { url: "http://b" } });
    vi.resetModules();
    const { loadConfig } = await import("./config-store.js");
    const config = loadConfig();

    expect(config.peers.existing.url).toBe("http://a");
    expect(config.peers.newPeer.url).toBe("http://b");
    delete process.env.EXOCLAW_PEERS;
  });

  it("creates default config on first boot when no files exist", async () => {
    // Remove the seed config path so it falls through to env defaults
    process.env.CONFIG_PATH = "/nonexistent/config.json";
    vi.resetModules();
    const { loadConfig } = await import("./config-store.js");
    const config = loadConfig();

    expect(config.name).toBe("agent");
    expect(config.port).toBe(8080);
    expect(config.session).toBeDefined();
    expect(config.session.provider).toBe("claude");

    // Verify it was persisted to config.yml
    expect(existsSync(join(TEST_HOME, ".exoclaw", "config.yml"))).toBe(true);
    delete process.env.CONFIG_PATH;
  });
});

// ── JSON -> YAML migration ──

describe("JSON -> YAML migration", () => {
  it("converts config.json + secrets.json into config.yml", async () => {
    const dir = join(TEST_HOME, ".exoclaw");

    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        name: "migrated-agent",
        port: 9090,
        claude: {
          model: "claude-opus-4",
          permissionMode: "default",
          systemPrompt: "Be helpful",
          mcpServers: { browser: { type: "stdio", command: "npx" } },
        },
        channels: { websocket: { enabled: true } },
      }),
    );
    writeFileSync(
      join(dir, "secrets.json"),
      JSON.stringify({
        apiToken: "secret-api-token",
        claudeApiToken: "claude-key-123",
        channels: { slack: { botToken: "xoxb-slack" } },
        tunnel: { token: "tunnel-tok" },
        embeddings: { apiKey: "embed-key" },
      }),
    );

    const { loadConfig } = await import("./config-store.js");
    const config = loadConfig();

    // Verify migration happened
    expect(existsSync(join(dir, "config.yml"))).toBe(true);
    expect(existsSync(join(dir, "config.json.bak"))).toBe(true);
    expect(existsSync(join(dir, "secrets.json.bak"))).toBe(true);
    // Original files should be gone
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    expect(existsSync(join(dir, "secrets.json"))).toBe(false);

    // Verify shape: claude -> session
    expect(config.session).toBeDefined();
    expect(config.session.provider).toBe("claude");
    expect(config.session.model).toBe("claude-opus-4");
    expect(config.session.systemPrompt).toBe("Be helpful");
    expect(config.session.providers.claude.permissionMode).toBe("default");
    expect(config.claude).toBeUndefined();

    // Verify secrets were merged
    expect(config.apiToken).toBe("secret-api-token");
    expect(config.session.providers.claude.apiKey).toBe("claude-key-123");

    // Verify mcpServers hoisted from claude -> top level
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.browser).toBeDefined();

    // Verify channel secrets merged
    expect(config.channels.slack.botToken).toBe("xoxb-slack");

    // Verify tunnel and embeddings secrets
    expect(config.tunnel.token).toBe("tunnel-tok");
    expect(config.embeddings.apiKey).toBe("embed-key");
  });

  it("reshapes claude key into session key correctly", async () => {
    const dir = join(TEST_HOME, ".exoclaw");

    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        name: "agent",
        claude: {
          model: "claude-sonnet-4-6",
          thinkingBudget: 50000,
          remoteControl: true,
          agents: ["helper"],
          allowedTools: ["Bash"],
          disallowedTools: ["Write"],
          extraFlags: ["--verbose"],
          permissionMode: "bypassPermissions",
        },
      }),
    );

    const { loadConfig } = await import("./config-store.js");
    const config = loadConfig();

    expect(config.session.model).toBe("claude-sonnet-4-6");
    expect(config.session.providers.claude.thinkingBudget).toBe(50000);
    expect(config.session.providers.claude.remoteControl).toBe(true);
    expect(config.session.providers.claude.agents).toEqual(["helper"]);
    expect(config.session.providers.claude.allowedTools).toEqual(["Bash"]);
    expect(config.session.providers.claude.disallowedTools).toEqual(["Write"]);
    expect(config.session.providers.claude.extraFlags).toEqual(["--verbose"]);
    expect(config.session.providers.claude.permissionMode).toBe("bypassPermissions");
  });

  it("handles migration with no secrets.json", async () => {
    const dir = join(TEST_HOME, ".exoclaw");

    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        name: "no-secrets-agent",
        claude: { model: "claude-sonnet-4-6" },
      }),
    );

    const { loadConfig } = await import("./config-store.js");
    const config = loadConfig();

    expect(config.name).toBe("no-secrets-agent");
    expect(config.session.model).toBe("claude-sonnet-4-6");
    expect(existsSync(join(dir, "config.yml"))).toBe(true);
  });
});

// ── loadConfigMasked ──

describe("loadConfigMasked", () => {
  it("masks SecretValue fields with the mask placeholder", async () => {
    const { SecretValue, stringifyYaml, MASK } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");

    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({
        name: "test-agent",
        apiToken: new SecretValue("real-token"),
        channels: {
          slack: { botToken: new SecretValue("xoxb-real"), enabled: true },
        },
      }),
    );

    vi.resetModules();
    const mod = await import("./config-store.js");
    const masked = mod.loadConfigMasked();

    expect(masked.apiToken).toBe(mod.MASK);
    expect(masked.channels.slack.botToken).toBe(mod.MASK);
    expect(masked.channels.slack.enabled).toBe(true);
    expect(masked.name).toBe("test-agent");
  });

  it("masks empty SecretValue as empty string", async () => {
    const { SecretValue, stringifyYaml } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");

    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({
        name: "test-agent",
        apiToken: new SecretValue(""),
      }),
    );

    vi.resetModules();
    const { loadConfigMasked } = await import("./config-store.js");
    const masked = loadConfigMasked();

    expect(masked.apiToken).toBe("");
  });
});

// ── saveConfigSafe mask restoration ──

describe("saveConfigSafe mask restoration", () => {
  it("restores masked values from disk when saved back", async () => {
    const { SecretValue, stringifyYaml, MASK } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");

    // Write initial config with real secrets
    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({
        name: "test-agent",
        apiToken: new SecretValue("real-secret-token"),
        channels: {
          slack: {
            botToken: new SecretValue("xoxb-real-slack-token"),
            enabled: true,
          },
        },
      }),
    );

    vi.resetModules();
    const mod = await import("./config-store.js");

    // Simulate a save with masked values (as the API would receive)
    mod.saveConfigSafe({
      name: "updated-agent",
      apiToken: mod.MASK,
      channels: {
        slack: {
          botToken: mod.MASK,
          enabled: false,
        },
      },
    });

    // Reload and verify secrets were preserved
    vi.resetModules();
    const { loadConfig } = await import("./config-store.js");
    const config = loadConfig();

    expect(config.name).toBe("updated-agent");
    expect(config.apiToken).toBe("real-secret-token");
    expect(config.channels.slack.botToken).toBe("xoxb-real-slack-token");
    expect(config.channels.slack.enabled).toBe(false);
  });

  it("accepts new secret values when they are not masked", async () => {
    const { SecretValue, stringifyYaml } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");

    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({
        name: "test-agent",
        apiToken: new SecretValue("old-token"),
      }),
    );

    vi.resetModules();
    const mod = await import("./config-store.js");

    // Save with a new token value
    mod.saveConfigSafe({
      name: "test-agent",
      apiToken: "new-token",
    });

    vi.resetModules();
    const { loadConfig } = await import("./config-store.js");
    const config = loadConfig();

    expect(config.apiToken).toBe("new-token");
  });

  it("restores deeply nested masked values", async () => {
    const { SecretValue, stringifyYaml, MASK } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");

    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({
        name: "test-agent",
        tunnel: { token: new SecretValue("tunnel-secret") },
        embeddings: { apiKey: new SecretValue("embed-key") },
      }),
    );

    vi.resetModules();
    const mod = await import("./config-store.js");

    mod.saveConfigSafe({
      name: "test-agent",
      tunnel: { token: mod.MASK },
      embeddings: { apiKey: mod.MASK },
    });

    vi.resetModules();
    const { loadConfig } = await import("./config-store.js");
    const config = loadConfig();

    expect(config.tunnel.token).toBe("tunnel-secret");
    expect(config.embeddings.apiKey).toBe("embed-key");
  });
});

// ── saveConfig ──

describe("saveConfig", () => {
  it("re-tags existing secret paths when saving", async () => {
    const { SecretValue, stringifyYaml, parseYaml } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");

    // Write initial config with secrets
    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({
        name: "test-agent",
        apiToken: new SecretValue("tok-123"),
      }),
    );

    vi.resetModules();
    const mod = await import("./config-store.js");

    // Save with a plain string for apiToken
    mod.saveConfig({
      name: "test-agent",
      apiToken: "tok-456",
    });

    // Read the raw YAML and verify the tag was preserved
    const raw = readFileSync(join(dir, "config.yml"), "utf-8");
    const parsed = mod.parseYaml(raw);

    expect(parsed.apiToken).toBeInstanceOf(mod.SecretValue);
    expect(parsed.apiToken.value).toBe("tok-456");
  });

  it("auto-tags SECRET_FIELD_HINTS fields in new saves", async () => {
    const { SecretValue, stringifyYaml, parseYaml } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");

    // Write initial config without secrets
    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({ name: "test-agent" }),
    );

    vi.resetModules();
    const mod = await import("./config-store.js");

    // Save with a new botToken field
    mod.saveConfig({
      name: "test-agent",
      channels: { slack: { botToken: "xoxb-new", enabled: true } },
    });

    const raw = readFileSync(join(dir, "config.yml"), "utf-8");
    const parsed = mod.parseYaml(raw);

    // botToken should be auto-tagged because it's in SECRET_FIELD_HINTS
    expect(parsed.channels.slack.botToken).toBeInstanceOf(mod.SecretValue);
    expect(parsed.channels.slack.botToken.value).toBe("xoxb-new");
    expect(parsed.channels.slack.enabled).toBe(true);
  });
});

// ── YAML file format ──

describe("YAML file format", () => {
  it("config.yml contains !secret tags on disk", async () => {
    const { SecretValue, stringifyYaml } = await import("./config-store.js");
    const dir = join(TEST_HOME, ".exoclaw");

    writeFileSync(
      join(dir, "config.yml"),
      stringifyYaml({
        name: "test-agent",
        apiToken: new SecretValue("visible-in-yaml"),
      }),
    );

    const raw = readFileSync(join(dir, "config.yml"), "utf-8");
    expect(raw).toContain("!secret");
    expect(raw).toContain("visible-in-yaml");
  });
});
