/**
 * Live execution logger for promptqa.
 *
 * All output goes to stderr so stdout stays clean for JSON contract output.
 * Emoji prefixes give instant visual context in the terminal.
 */

// ── Core write ──────────────────────────────────────────────

function write(message: string): void {
  process.stderr.write(message + '\n');
}

// ── Public API ──────────────────────────────────────────────

export function info(message: string): void {
  write(`ℹ️  ${message}`);
}

export function detail(message: string): void {
  write(`   ${message}`);
}

export function step(index: number, total: number, description: string): void {
  write(`📋 [${String(index + 1)}/${String(total)}] ${description}`);
}

export function stepResult(
  index: number,
  total: number,
  success: boolean,
  description: string,
): void {
  const icon = success ? '✅' : '❌';
  write(`${icon} [${String(index + 1)}/${String(total)}] ${description}`);
}

export function section(title: string): void {
  write(`\n${'─'.repeat(50)}`);
  write(`▶  ${title}`);
  write(`${'─'.repeat(50)}`);
}

export function warn(message: string): void {
  write(`⚠️  ${message}`);
}

export function error(message: string): void {
  write(`💥 ${message}`);
}

export function prescan(elementCount: number, url: string): void {
  write(`🔍 Prescan: ${String(elementCount)} interactive elements found on ${url}`);
}

export function planned(stepCount: number): void {
  write(`🧠 Planner: generated ${String(stepCount)} steps`);
}

export function login(message: string): void {
  write(`🔐 ${message}`);
}

export function llm(message: string): void {
  write(`🧠 ${message}`);
}
