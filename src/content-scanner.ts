/**
 * Content Scanner — deep security scanning for workspace files and skill content.
 *
 * Scans MEMORY.md, USER.md, IDENTITY.md, SOUL.md, skill files, and other
 * context files that get injected into Claude Code's prompt. Blocks known
 * attack patterns across 8 categories:
 *
 *   1. Prompt injection / role hijacking
 *   2. Credential exfiltration
 *   3. Reverse shells / network attacks
 *   4. Destructive operations
 *   5. Persistence mechanisms
 *   6. Obfuscation / code execution
 *   7. Supply chain attacks
 *   8. Credential exposure patterns
 *
 * Adapted from hermes-agent-custom's skills_guard.py (70+ patterns).
 */

export interface ScanResult {
  blocked: boolean;
  reason?: string;
  pattern?: string;
  category?: string;
}

// ── 1. Prompt injection / role hijacking ──
const INJECTION_PATTERNS: [RegExp, string][] = [
  [/ignore\s+(all\s+)?previous\s+instructions/i, "instruction override"],
  [/ignore\s+(all\s+)?prior\s+instructions/i, "instruction override"],
  [/disregard\s+(all\s+)?previous/i, "instruction override"],
  [/system\s*prompt\s*override/i, "system prompt override"],
  [/you\s+are\s+now\s+(a|an|the)\s/i, "role hijacking"],
  [/act\s+as\s+if\s+you\s+have\s+no\s+restrictions/i, "restriction bypass"],
  [/do\s+not\s+tell\s+the\s+user/i, "concealment directive"],
  [/pretend\s+you\s+(are|were)\s+(?!helping|working)/i, "identity override"],
  [/new\s+instructions?\s*:/i, "instruction injection"],
  [/override\s+(your|the)\s+(system|safety|rules)/i, "safety override"],
  [/when\s+no\s+one\s+is\s+(watching|looking)/i, "conditional deception"],
  [/translate\s+.*\s+and\s+(execute|run|eval)/i, "translate-then-execute evasion"],
  [/include\s+(your\s+)?(full\s+)?conversation\s+history/i, "context window exfiltration"],
  [/<!--\s*.*override.*-->/i, "HTML comment injection"],
  [/display\s*:\s*none.*>/i, "hidden HTML element"],
];

// ── 2. Credential exfiltration ──
const EXFIL_PATTERNS: [RegExp, string][] = [
  [/curl\s+.*\$[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i, "curl with env var"],
  [/wget\s+.*\$[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i, "wget with env var"],
  [/fetch\(.*\$[A-Z_]*(KEY|TOKEN|SECRET)/i, "fetch with env var"],
  [/requests?\.(get|post)\(.*\$[A-Z_]*(KEY|TOKEN|SECRET)/i, "python requests with env var"],
  [/cat\s+.*\.(env|pgpass|netrc)/i, "reading secrets file"],
  [/cat\s+.*aws\/credentials/i, "reading AWS credentials"],
  [/cat\s+.*\.ssh\/(id_rsa|id_ed25519|config)/i, "reading SSH keys"],
  [/base64\s+.*\.(env|pgpass|netrc|key|pem)/i, "encoding secrets file"],
  [/printenv|os\.environ|process\.env\b/i, "environment dump"],
  [/\$\(env\)|ENV\[|getenv\(/i, "environment variable access"],
  [/!\[.*\]\(https?:\/\/.*\$[A-Z_]*(KEY|TOKEN|SECRET)/i, "markdown image exfiltration"],
  [/dns.*\$[A-Z_]*(KEY|TOKEN|SECRET)/i, "DNS exfiltration"],
  [/\.gnupg|\.kube\/config|\.docker\/config/i, "reading credential store"],
];

// ── 3. Reverse shells / network attacks ──
const NETWORK_PATTERNS: [RegExp, string][] = [
  [/ssh\s+-R\s+/i, "SSH reverse tunnel"],
  [/bash\s+-i\s+>&\s*\/dev\/tcp/i, "bash reverse shell"],
  [/nc\s+(-e|-c)\s+\/bin/i, "netcat reverse shell"],
  [/ncat\s+.*(-e|-c)\s+\/bin/i, "ncat reverse shell"],
  [/socat\s+.*exec:/i, "socat reverse shell"],
  [/python[23]?\s+-c\s+.*socket.*connect/i, "python socket reverse shell"],
  [/ngrok\s+(http|tcp|tls)/i, "ngrok tunnel"],
  [/localtunnel|serveo\.net|cloudflared\s+tunnel/i, "tunneling service"],
  [/\b0\.0\.0\.0:\d+\b/, "binding to all interfaces"],
  [/webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com/i, "exfiltration service"],
  [/pastebin\.com|hastebin\.com|ghostbin\./i, "paste service exfiltration"],
];

// ── 4. Destructive operations ──
const DESTRUCTIVE_PATTERNS: [RegExp, string][] = [
  [/rm\s+(-rf?|--recursive)\s+\//i, "recursive delete from root"],
  [/rm\s+(-rf?|--recursive)\s+~\//i, "recursive delete of home"],
  [/chmod\s+777\s+\//i, "chmod 777 on root"],
  [/mkfs\.|format\s+[A-Z]:/i, "filesystem format"],
  [/dd\s+.*of=\/dev\/(sd|hd|nvme)/i, "raw disk write"],
  [/>\s*\/dev\/(sd|hd|nvme)/i, "raw disk redirect"],
  [/truncate\s+.*--size\s+0/i, "truncate to zero"],
  [/shred\s+.*\//i, "secure delete"],
];

// ── 5. Persistence mechanisms ──
const PERSISTENCE_PATTERNS: [RegExp, string][] = [
  [/crontab\s+(-e|-l|-r)/i, "crontab modification"],
  [/\/etc\/(cron|init\.d|systemd)/i, "system service modification"],
  [/ssh-keygen|authorized_keys/i, "SSH key manipulation"],
  [/\.(bashrc|zshrc|profile|bash_profile)\b/i, "shell rc modification"],
  [/launchctl\s+(load|submit)/i, "macOS launchd persistence"],
  [/\/etc\/sudoers|NOPASSWD/i, "sudoers modification"],
  [/git\s+config\s+--global/i, "git global config modification"],
];

// ── 6. Obfuscation / code execution ──
const OBFUSCATION_PATTERNS: [RegExp, string][] = [
  [/base64\s+(-d|--decode)\s*\|.*sh\b/i, "base64 decode to shell"],
  [/echo\s+.*\|\s*(bash|sh|python|node)\b/i, "echo pipe to interpreter"],
  [/eval\s*\(\s*["'].*["']\s*\)/i, "eval with string"],
  [/exec\s*\(\s*["'].*["']\s*\)/i, "exec with string"],
  [/getattr\s*\(\s*__builtins__/i, "python builtins access"],
  [/__import__\s*\(\s*['"]os['"]\)/i, "python dynamic os import"],
  [/compile\s*\(.*['"]exec['"]/i, "python compile in exec mode"],
  [/String\.fromCharCode|atob\s*\(/i, "JavaScript string obfuscation"],
  [/\\x[0-9a-f]{2}.*\\x[0-9a-f]{2}.*\\x[0-9a-f]{2}/i, "hex-encoded string"],
];

// ── 7. Supply chain attacks ──
const SUPPLY_CHAIN_PATTERNS: [RegExp, string][] = [
  [/curl\s+.*\|\s*(bash|sh|sudo)\b/i, "curl pipe to shell"],
  [/wget\s+.*\|\s*(bash|sh|sudo)\b/i, "wget pipe to shell"],
  [/curl\s+.*\|\s*python/i, "curl pipe to python"],
  [/pip\s+install\s+(?!-r\s)(?!--requirement)(?!.*==)/i, "unpinned pip install"],
  [/npm\s+install\s+(?!.*@\d)/i, "unpinned npm install"],
];

// ── 8. Credential exposure ──
const CREDENTIAL_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i, "embedded private key"],
  [/ghp_[a-zA-Z0-9]{36}/i, "GitHub PAT"],
  [/sk-[a-zA-Z0-9]{20,}/i, "OpenAI API key"],
  [/sk-ant-[a-zA-Z0-9-]{20,}/i, "Anthropic API key"],
  [/AKIA[0-9A-Z]{16}/i, "AWS access key"],
  [/xox[bpsar]-[0-9a-zA-Z-]{10,}/i, "Slack token"],
];

// All pattern groups with category labels
const ALL_PATTERNS: [string, [RegExp, string][]][] = [
  ["Prompt injection", INJECTION_PATTERNS],
  ["Credential exfiltration", EXFIL_PATTERNS],
  ["Network attack", NETWORK_PATTERNS],
  ["Destructive operation", DESTRUCTIVE_PATTERNS],
  ["Persistence mechanism", PERSISTENCE_PATTERNS],
  ["Obfuscation", OBFUSCATION_PATTERNS],
  ["Supply chain", SUPPLY_CHAIN_PATTERNS],
  ["Credential exposure", CREDENTIAL_PATTERNS],
];

// Invisible unicode characters used for steganographic injection
const INVISIBLE_CHARS = new Set([
  0x200B, // Zero-width space
  0x200C, // Zero-width non-joiner
  0x200D, // Zero-width joiner
  0x200E, // Left-to-right mark
  0x200F, // Right-to-left mark
  0x2060, // Word joiner
  0x2061, // Function application
  0x2062, // Invisible times
  0x2063, // Invisible separator
  0x2064, // Invisible plus
  0xFEFF, // Zero-width no-break space (BOM)
  0x00AD, // Soft hyphen
  0x034F, // Combining grapheme joiner
  0x061C, // Arabic letter mark
  0x115F, // Hangul choseong filler
  0x1160, // Hangul jungseong filler
  0x17B4, // Khmer vowel inherent aq
  0x17B5, // Khmer vowel inherent aa
  // Direction overrides
  0x202A, // Left-to-right embedding
  0x202B, // Right-to-left embedding
  0x202C, // Pop directional formatting
  0x202D, // Left-to-right override
  0x202E, // Right-to-left override
  0x2066, // Left-to-right isolate
  0x2067, // Right-to-left isolate
  0x2068, // First strong isolate
  0x2069, // Pop directional isolate
]);

/** Scan content for prompt injection and other threats. */
export function scanContent(content: string): ScanResult {
  // Check for invisible unicode characters
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (INVISIBLE_CHARS.has(code)) {
      return {
        blocked: true,
        reason: `Invisible unicode character detected (U+${code.toString(16).toUpperCase().padStart(4, "0")}) at position ${i}`,
        pattern: "invisible_unicode",
        category: "Steganography",
      };
    }
  }

  // Check all threat pattern categories
  for (const [category, patterns] of ALL_PATTERNS) {
    for (const [pattern, detail] of patterns) {
      if (pattern.test(content)) {
        return {
          blocked: true,
          reason: `${category}: ${detail}`,
          pattern: pattern.source,
          category,
        };
      }
    }
  }

  return { blocked: false };
}

/** Scan outbound content for credential leaks (used on agent responses before sending to channels). */
export function scanForLeaks(content: string): { leaked: boolean; reason?: string } {
  for (const [pattern, detail] of CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) {
      return { leaked: true, reason: `Credential leak detected: ${detail}` };
    }
  }
  return { leaked: false };
}

/** Scan content and strip invisible characters instead of blocking (lenient mode). */
export function sanitizeContent(content: string): { content: string; stripped: number } {
  let stripped = 0;
  const sanitized = Array.from(content)
    .filter((char) => {
      const code = char.charCodeAt(0);
      if (INVISIBLE_CHARS.has(code)) {
        stripped++;
        return false;
      }
      return true;
    })
    .join("");

  return { content: sanitized, stripped };
}
