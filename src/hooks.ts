/**
 * Hook System — extensible pre/post processing for messages and events.
 *
 * Hooks allow users to add custom behavior without modifying source code.
 * Hooks are loaded from ~/workspace/.claude/hooks/ as JS/TS modules.
 *
 * Hook points:
 *   - pre_message:   before a message is sent to Claude (can modify prompt)
 *   - post_message:  after Claude responds (can modify response)
 *   - pre_tool:      before a tool call is executed (can block)
 *   - post_tool:     after a tool call returns
 *   - on_session:    when a session starts/ends
 *   - on_cron:       after a cron job completes
 *
 * Hook file format:
 *   export default {
 *     name: "my-hook",
 *     hooks: {
 *       pre_message: async (ctx) => { ctx.prompt = "modified: " + ctx.prompt; },
 *       post_message: async (ctx) => { log(ctx.response); },
 *     }
 *   }
 *
 * Inspired by Hermes's plugin system and OpenClaw's hook architecture.
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";

// ── Types ──

export interface HookContext {
  /** The event type that triggered this hook. */
  event: string;
  /** Message/prompt content (mutable for pre_message). */
  prompt?: string;
  /** Response content (mutable for post_message). */
  response?: string;
  /** Source channel (webhook, ws, slack, discord, etc.). */
  source?: string;
  /** Tool name (for tool hooks). */
  toolName?: string;
  /** Tool args (for tool hooks). */
  toolArgs?: string;
  /** Tool output (for post_tool). */
  toolOutput?: string;
  /** Whether to block/skip this operation. Set to true in pre_ hooks to cancel. */
  blocked?: boolean;
  /** Reason for blocking. */
  blockReason?: string;
  /** Arbitrary metadata for hook-to-hook communication. */
  meta: Record<string, any>;
}

export type HookFn = (ctx: HookContext) => Promise<void> | void;

export type HookPoint =
  | "pre_message"
  | "post_message"
  | "pre_tool"
  | "post_tool"
  | "on_session"
  | "on_cron";

export interface HookPlugin {
  name: string;
  hooks: Partial<Record<HookPoint, HookFn>>;
}

// ── Registry ──

export class HookRegistry {
  private plugins: HookPlugin[] = [];
  private hooksDir: string;

  constructor(hooksDir?: string) {
    this.hooksDir = hooksDir ?? join(process.env.HOME || "/home/agent", "workspace", ".claude", "hooks");
  }

  /** Register a hook plugin programmatically. */
  register(plugin: HookPlugin): void {
    this.plugins.push(plugin);
    log("info", `Registered hook plugin: ${plugin.name}`);
  }

  /** Load hook plugins from the hooks directory. */
  async loadFromDisk(): Promise<number> {
    if (!existsSync(this.hooksDir)) return 0;

    let loaded = 0;
    const files = readdirSync(this.hooksDir).filter(f =>
      f.endsWith(".js") || f.endsWith(".mjs")
    );

    for (const file of files) {
      try {
        const fullPath = join(this.hooksDir, file);
        const mod = await import(`file://${fullPath}`);
        const plugin: HookPlugin = mod.default || mod;

        if (plugin.name && plugin.hooks) {
          this.plugins.push(plugin);
          loaded++;
          log("info", `Loaded hook plugin: ${plugin.name} from ${file}`);
        }
      } catch (err) {
        log("error", `Failed to load hook ${file}: ${err}`);
      }
    }

    return loaded;
  }

  /** Run all hooks for a given hook point. Modifies ctx in place. */
  async run(point: HookPoint, ctx: HookContext): Promise<void> {
    for (const plugin of this.plugins) {
      const hookFn = plugin.hooks[point];
      if (!hookFn) continue;

      try {
        await hookFn(ctx);
        // If a pre_ hook blocked, stop processing
        if (ctx.blocked && point.startsWith("pre_")) break;
      } catch (err) {
        log("error", `Hook ${plugin.name}.${point} failed: ${err}`);
      }
    }
  }

  /** Check if any hooks are registered for a given point. */
  hasHooks(point: HookPoint): boolean {
    return this.plugins.some(p => p.hooks[point] !== undefined);
  }

  /** List all registered plugins. */
  list(): { name: string; hooks: string[] }[] {
    return this.plugins.map(p => ({
      name: p.name,
      hooks: Object.keys(p.hooks) as string[],
    }));
  }

  /** Remove a plugin by name. */
  unregister(name: string): boolean {
    const idx = this.plugins.findIndex(p => p.name === name);
    if (idx < 0) return false;
    this.plugins.splice(idx, 1);
    return true;
  }
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(JSON.stringify({ ts, level, component: "hooks", msg }) + "\n");
}
