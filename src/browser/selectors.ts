import type { Locator, Page } from 'playwright';

import type { SelectorHint, SelectorStrategy } from '../schema/step.js';

// ── Error ─────────────────────────────────────────────────────

export class SelectorError extends Error {
  readonly strategy: SelectorStrategy;
  readonly hint: SelectorHint;

  constructor(strategy: SelectorStrategy, hint: SelectorHint, reason: string) {
    super(`Element not found with strategy ${strategy}: ${reason}`);
    this.name = 'SelectorError';
    this.strategy = strategy;
    this.hint = hint;
  }
}

// ── Resolver ──────────────────────────────────────────────────

/**
 * Maps a SelectorHint to a Playwright Locator.
 *
 * Priority (enforced by the planner, not this function):
 *   1. data-testid  → page.getByTestId(value)
 *   2. role + name  → page.getByRole(role, { name })
 *   3. text content → page.getByText(value)
 *   4. css selector → page.locator(value)
 *
 * No auto-fallback: if the strategy is wrong, the locator will
 * fail at action time with a clear error from the runner.
 */
export function resolveSelector(page: Page, hint: SelectorHint): Locator {
  switch (hint.strategy) {
    case 'testid':
      return page.getByTestId(hint.value);

    case 'role':
      return resolveRole(page, hint);

    case 'text':
      return page.getByText(hint.value);

    case 'css':
      return page.locator(hint.value);
  }
}

function resolveRole(page: Page, hint: SelectorHint): Locator {
  if (!hint.role) {
    throw new SelectorError(
      'role',
      hint,
      `missing required "role" field (e.g. "button", "link", "textbox")`,
    );
  }

  const options: { name?: string | RegExp } = {};
  if (hint.name) {
    options.name = hint.name;
  }

  // Playwright accepts the ARIA role as a plain string at runtime.
  // The TypeScript overload expects a union literal, so we cast once here.
  return page.getByRole(hint.role as Parameters<Page['getByRole']>[0], options);
}

// ── Description helper ────────────────────────────────────────

/** Human-readable one-liner describing the selector for reports. */
export function describeSelector(hint: SelectorHint): string {
  switch (hint.strategy) {
    case 'testid':
      return `[data-testid="${hint.value}"]`;
    case 'role':
      return hint.name
        ? `role=${hint.role ?? 'unknown'}[name="${hint.name}"]`
        : `role=${hint.role ?? 'unknown'}`;
    case 'text':
      return `text="${hint.value}"`;
    case 'css':
      return hint.value;
  }
}
