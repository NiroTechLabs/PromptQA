import type { BrowserContext, Page } from 'playwright';

import type { LLMClient } from '../llm/index.js';
import type { Step } from '../schema/index.js';
import { TIMEOUTS } from '../config/defaults.js';
import { planSteps } from '../core/planner.js';
import { prescanPage } from './prescan.js';
import { resolveSelector } from './selectors.js';

// ── Cookie injection ────────────────────────────────────────

/**
 * Parse a cookie string ("name=value; name2=value2") and inject
 * all cookies into the browser context before navigation begins.
 *
 * Playwright requires a `url` to scope each cookie — the target
 * URL is used so cookies attach to the correct origin.
 */
export async function injectCookies(
  context: BrowserContext,
  cookies: string,
  url: string,
): Promise<void> {
  const pairs = cookies
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  const parsed = pairs.map((pair) => {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) {
      throw new Error(`Invalid cookie format: "${pair}" (expected name=value)`);
    }
    return {
      name: pair.slice(0, eqIdx).trim(),
      value: pair.slice(eqIdx + 1).trim(),
    };
  });

  if (parsed.length === 0) return;

  await context.addCookies(
    parsed.map((c) => ({
      name: c.name,
      value: c.value,
      url,
    })),
  );
}

// ── Login flow ──────────────────────────────────────────────

/**
 * Run a natural-language login prompt through the planner → runner
 * pipeline before the actual test. The browser context (session
 * cookies, localStorage) is preserved so subsequent test steps
 * execute in an authenticated state.
 *
 * Note: the LLM call happens inside `planSteps` (core/planner),
 * not in this module — the determinism rule is preserved.
 */
export async function runLoginFlow(
  context: BrowserContext,
  llm: LLMClient,
  prompt: string,
  url: string,
): Promise<void> {
  const page = context.pages()[0] ?? await context.newPage();

  const snapshot = await prescanPage(page, url);

  const steps = await planSteps(llm, {
    prompt,
    baseUrl: url,
    snapshot,
  });

  for (const step of steps) {
    await executeLoginStep(page, step);
  }
}

// ── Internal step executor (minimal, no artifacts) ──────────

async function executeLoginStep(page: Page, step: Step): Promise<void> {
  switch (step.type) {
    case 'goto':
      await page.goto(step.value, {
        timeout: step.timeout ?? TIMEOUTS.NAVIGATION_TIMEOUT,
        waitUntil: 'domcontentloaded',
      });
      break;

    case 'click': {
      const loc = resolveSelector(page, step.selector);
      await loc.click({ timeout: step.timeout ?? TIMEOUTS.ACTION_TIMEOUT });
      break;
    }

    case 'type': {
      const loc = resolveSelector(page, step.selector);
      await loc.fill(step.value, {
        timeout: step.timeout ?? TIMEOUTS.ACTION_TIMEOUT,
      });
      break;
    }

    case 'select': {
      const loc = resolveSelector(page, step.selector);
      await loc.selectOption(step.value, {
        timeout: step.timeout ?? TIMEOUTS.ACTION_TIMEOUT,
      });
      break;
    }

    case 'upload': {
      const loc = resolveSelector(page, step.selector);
      await loc.setInputFiles(step.value, {
        timeout: step.timeout ?? TIMEOUTS.ACTION_TIMEOUT,
      });
      break;
    }

    case 'wait':
      if (step.selector) {
        const loc = resolveSelector(page, step.selector);
        await loc.waitFor({
          state: 'visible',
          timeout: step.timeout ?? TIMEOUTS.ACTION_TIMEOUT,
        });
      } else if (step.value) {
        const ms = Number(step.value);
        if (!Number.isNaN(ms)) await page.waitForTimeout(ms);
      }
      break;

    case 'expect_text': {
      const timeout = step.timeout ?? TIMEOUTS.ACTION_TIMEOUT;
      const loc = step.selector
        ? resolveSelector(page, step.selector)
        : page.locator('body');
      await loc.waitFor({ state: 'visible', timeout });
      const text = await loc.innerText();
      if (!text.includes(step.value)) {
        throw new Error(
          `Login flow: expected text "${step.value}" not found`,
        );
      }
      break;
    }
  }
}
