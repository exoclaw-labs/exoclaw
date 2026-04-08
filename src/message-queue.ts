/**
 * Message Queue — configurable queuing strategies for inbound messages.
 *
 * Three modes (inspired by OpenClaw's queue system):
 *   - followup: hold message until current turn ends, then process (default)
 *   - collect:  debounce rapid messages into one combined prompt
 *   - reject:   reject immediately when busy (legacy behavior)
 *
 * Used by the webhook endpoint and channel adapters when the session is busy.
 */

export type QueueMode = "followup" | "collect" | "reject";

export interface QueueConfig {
  mode: QueueMode;
  maxQueueSize: number;
  collectTimeoutMs: number;  // for "collect" mode: debounce window
  maxWaitMs: number;         // max time to wait before giving up
}

interface QueuedMessage {
  content: string;
  source: string;
  timestamp: number;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
}

type SendFn = (prompt: string) => AsyncGenerator<{ type: string; content: string }>;

export class MessageQueue {
  private config: QueueConfig;
  private queue: QueuedMessage[] = [];
  private processing = false;
  private collectBuffer: { messages: string[]; timer: ReturnType<typeof setTimeout> | null; entry: QueuedMessage | null } = {
    messages: [],
    timer: null,
    entry: null,
  };

  constructor(config?: Partial<QueueConfig>) {
    this.config = {
      mode: config?.mode ?? "followup",
      maxQueueSize: config?.maxQueueSize ?? 20,
      collectTimeoutMs: config?.collectTimeoutMs ?? 3000,
      maxWaitMs: config?.maxWaitMs ?? 5 * 60_000,
    };
  }

  /**
   * Enqueue a message. Returns the full response text when processed.
   * Rejects immediately if mode is "reject" and session is busy.
   */
  async enqueue(
    content: string,
    source: string,
    isBusy: () => boolean,
    send: SendFn,
  ): Promise<string> {
    // Not busy — process immediately
    if (!isBusy()) {
      return this.processMessage(content, send);
    }

    // Reject mode — fail fast
    if (this.config.mode === "reject") {
      throw new Error("Session is busy");
    }

    // Queue full
    if (this.queue.length >= this.config.maxQueueSize) {
      throw new Error(`Queue full (${this.config.maxQueueSize} messages pending)`);
    }

    // Collect mode — debounce into one message
    if (this.config.mode === "collect") {
      return this.collectMessage(content, source, isBusy, send);
    }

    // Followup mode — queue and wait
    return new Promise<string>((resolve, reject) => {
      const entry: QueuedMessage = { content, source, timestamp: Date.now(), resolve, reject };
      this.queue.push(entry);

      // Timeout
      const timeout = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new Error("Queue timeout — message was not processed in time"));
        }
      }, this.config.maxWaitMs);

      // Override reject to clear timeout
      const origReject = entry.reject;
      entry.reject = (err) => { clearTimeout(timeout); origReject(err); };
      const origResolve = entry.resolve;
      entry.resolve = (result) => { clearTimeout(timeout); origResolve(result); };

      this.drainQueue(isBusy, send);
    });
  }

  private collectMessage(
    content: string,
    source: string,
    isBusy: () => boolean,
    send: SendFn,
  ): Promise<string> {
    this.collectBuffer.messages.push(content);

    // Reset debounce timer
    if (this.collectBuffer.timer) {
      clearTimeout(this.collectBuffer.timer);
    }

    // If this is the first message in the batch, create the promise
    if (!this.collectBuffer.entry) {
      return new Promise<string>((resolve, reject) => {
        this.collectBuffer.entry = { content: "", source, timestamp: Date.now(), resolve, reject };
        this.scheduleCollectFlush(isBusy, send);
      });
    }

    // Additional messages share the existing promise
    return new Promise<string>((resolve, reject) => {
      const entry = this.collectBuffer.entry!;
      const origResolve = entry.resolve;
      const origReject = entry.reject;
      entry.resolve = (result) => { origResolve(result); resolve(result); };
      entry.reject = (err) => { origReject(err); reject(err); };
      this.scheduleCollectFlush(isBusy, send);
    });
  }

  private scheduleCollectFlush(isBusy: () => boolean, send: SendFn): void {
    if (this.collectBuffer.timer) clearTimeout(this.collectBuffer.timer);
    this.collectBuffer.timer = setTimeout(() => {
      this.flushCollect(isBusy, send);
    }, this.config.collectTimeoutMs);
  }

  private flushCollect(isBusy: () => boolean, send: SendFn): void {
    const messages = this.collectBuffer.messages;
    const entry = this.collectBuffer.entry;
    this.collectBuffer = { messages: [], timer: null, entry: null };

    if (!entry || messages.length === 0) return;

    // Combine messages into one prompt
    const combined = messages.length === 1
      ? messages[0]
      : messages.map((m, i) => `[Message ${i + 1}]: ${m}`).join("\n\n");
    entry.content = combined;

    this.queue.push(entry);
    this.drainQueue(isBusy, send);
  }

  private async drainQueue(isBusy: () => boolean, send: SendFn): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      // Wait for session to be free
      const deadline = Date.now() + this.config.maxWaitMs;
      while (isBusy()) {
        if (Date.now() > deadline) {
          // Timeout all remaining queued messages
          for (const entry of this.queue.splice(0)) {
            entry.reject(new Error("Queue timeout"));
          }
          this.processing = false;
          return;
        }
        await new Promise(r => setTimeout(r, 300));
      }

      const entry = this.queue.shift();
      if (!entry) break;

      try {
        const result = await this.processMessage(entry.content, send);
        entry.resolve(result);
      } catch (err) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.processing = false;
  }

  private async processMessage(content: string, send: SendFn): Promise<string> {
    let fullText = "";
    for await (const event of send(content)) {
      if (event.type === "chunk") fullText += event.content;
      if (event.type === "done") fullText = event.content || fullText;
    }
    return fullText;
  }

  /** Number of messages waiting in the queue. */
  get pending(): number { return this.queue.length; }

  /** Current queue mode. */
  get mode(): QueueMode { return this.config.mode; }

  /** Update config at runtime. */
  updateConfig(config: Partial<QueueConfig>): void {
    if (config.mode !== undefined) this.config.mode = config.mode;
    if (config.maxQueueSize !== undefined) this.config.maxQueueSize = config.maxQueueSize;
    if (config.collectTimeoutMs !== undefined) this.config.collectTimeoutMs = config.collectTimeoutMs;
    if (config.maxWaitMs !== undefined) this.config.maxWaitMs = config.maxWaitMs;
  }
}
