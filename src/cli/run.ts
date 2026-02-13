import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';

import type { RunSummary } from '../schema/index.js';
import type { CookieParam } from '../browser/runner.js';
import { createLLMClient, loadLLMConfig } from '../llm/index.js';
import { runAgentLoop } from '../core/agentLoop.js';
import { generateMarkdown, generateJSON } from '../report/reporter.js';
import { LIMITS, TIMEOUTS } from '../config/defaults.js';

// ── Config file shape ────────────────────────────────────────

interface FileConfig {
  headless?: boolean;
  maxSteps?: number;
  timeout?: number;
  reportPath?: string;
  cookie?: string;
  loginPrompt?: string;
}

// ── Config file loading ──────────────────────────────────────

async function loadConfigFile(configPath: string): Promise<FileConfig> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    if (configPath.endsWith('.json')) {
      return JSON.parse(raw) as FileConfig;
    }
    return (parseYaml(raw) ?? {}) as FileConfig;
  } catch {
    return {};
  }
}

// ── Cookie parsing ───────────────────────────────────────────

function parseCookies(raw: string, url: string): CookieParam[] {
  return raw
    .split(';')
    .map((pair) => {
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) return null;
      const name = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      if (name.length === 0) return null;
      return { name, value, url };
    })
    .filter((c): c is CookieParam => c !== null);
}

// ── Stderr summary ───────────────────────────────────────────

function printSummary(summary: RunSummary): void {
  const passed = summary.steps.filter(
    (s) => s.evaluation?.result === 'PASS',
  ).length;
  const failed = summary.steps.filter(
    (s) => !s.success || s.evaluation?.result === 'FAIL',
  ).length;
  const uncertain = summary.steps.filter(
    (s) => s.evaluation?.result === 'UNCERTAIN',
  ).length;

  process.stderr.write(`\n--- PromptQA Result ---\n`);
  process.stderr.write(`URL:     ${summary.url}\n`);
  process.stderr.write(`Prompt:  ${summary.prompt}\n`);
  process.stderr.write(`Result:  ${summary.summary}\n`);
  process.stderr.write(
    `Steps:   ${String(passed)} passed, ${String(failed)} failed, ${String(uncertain)} uncertain\n`,
  );
  process.stderr.write(`Bugs:    ${String(summary.bugs.length)}\n`);
  process.stderr.write(
    `Time:    ${(summary.durationMs / 1000).toFixed(1)}s\n`,
  );
  process.stderr.write(`Run ID:  ${summary.runId}\n\n`);
}

// ── Command registration ─────────────────────────────────────

export function registerTestCommand(program: Command): void {
  program
    .command('test')
    .description('Run a prompt-driven test against a URL')
    .argument('<url>', 'Target URL to test')
    .argument('<prompt>', 'Natural language test prompt')
    .option('--json', 'Output JSON to stdout')
    .option(
      '--report-path <dir>',
      'Custom artifact directory',
      '.artifacts',
    )
    .option(
      '--max-steps <n>',
      'Override max steps',
      String(LIMITS.MAX_STEPS),
    )
    .option('--headless', 'Run browser headless')
    .option(
      '--timeout <seconds>',
      'Total run timeout in seconds',
      String(TIMEOUTS.TOTAL_RUN_TIMEOUT / 1000),
    )
    .option(
      '--config <path>',
      'Path to config file',
      '.promptqa.yaml',
    )
    .option('--cookie <string>', 'Pre-authenticated cookie string')
    .option(
      '--login-prompt <prompt>',
      'Login prompt to execute before test',
    )
    .action(
      async (
        url: string,
        prompt: string,
        opts: {
          json?: true;
          reportPath: string;
          maxSteps: string;
          headless?: true;
          timeout: string;
          config: string;
          cookie?: string;
          loginPrompt?: string;
        },
      ) => {
        try {
          // 1. Load config file (CLI flags override)
          const fileConfig = await loadConfigFile(opts.config);

          // 2. Merge config: CLI flags take precedence
          const headless =
            opts.headless ?? fileConfig.headless ?? false;
          const maxSteps =
            Number(opts.maxSteps) || fileConfig.maxSteps || LIMITS.MAX_STEPS;
          const timeoutSec =
            Number(opts.timeout) ||
            fileConfig.timeout ||
            TIMEOUTS.TOTAL_RUN_TIMEOUT / 1000;
          const reportPath = opts.reportPath ?? fileConfig.reportPath ?? '.artifacts';
          const cookieString = opts.cookie ?? fileConfig.cookie;
          const loginPrompt = opts.loginPrompt ?? fileConfig.loginPrompt;

          // 3. Parse cookies
          const cookies =
            cookieString !== undefined
              ? parseCookies(cookieString, url)
              : undefined;

          // 4. Create LLM client
          const llmConfig = loadLLMConfig();
          const client = createLLMClient(llmConfig);

          // 5. Run agent loop
          const outputDir = path.resolve(reportPath);
          const { summary, exitCode } = await runAgentLoop(client, {
            url,
            prompt,
            headless,
            outputDir,
            maxSteps,
            totalTimeout: timeoutSec * 1000,
            ...(cookies !== undefined ? { cookies } : {}),
            ...(loginPrompt !== undefined ? { loginPrompt } : {}),
          });

          // 6. Write markdown report
          const markdown = generateMarkdown(summary);
          await writeFile(
            path.join(outputDir, 'report.md'),
            markdown,
            'utf-8',
          );

          // 7. JSON to stdout if --json
          if (opts.json) {
            const json = generateJSON(summary);
            process.stdout.write(JSON.stringify(json, null, 2) + '\n');
          }

          // 8. Summary to stderr always
          printSummary(summary);

          // 9. Exit code
          process.exitCode = exitCode;
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          process.stderr.write(`Error: ${message}\n`);
          process.exitCode = 4;
        }
      },
    );
}
