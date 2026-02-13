import type { Page } from 'playwright';

import type { ConsoleEntry, NetworkFailure, PageErrorEntry, StepCapture } from '../schema/index.js';
import { TOKEN_GUARDS } from '../config/defaults.js';

// ── Public interface ─────────────────────────────────────────

export interface CaptureCollector {
  /** Return accumulated capture data and reset all buffers. */
  flush(): StepCapture;
}

// ── Factory ──────────────────────────────────────────────────

/**
 * Attach capture listeners to a Playwright page.
 * Call once at page creation — listeners persist for the session.
 * Use `flush()` at each step boundary to drain and reset buffers.
 */
export function attachCapture(page: Page): CaptureCollector {
  let consoleEntries: ConsoleEntry[] = [];
  let networkFailures: NetworkFailure[] = [];
  let pageErrors: PageErrorEntry[] = [];

  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;

    consoleEntries.push({
      level: type === 'warning' ? 'warn' : 'error',
      text: msg.text(),
    });
  });

  page.on('response', (response) => {
    if (response.status() < 400) return;

    networkFailures.push({
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
      method: response.request().method(),
    });
  });

  page.on('pageerror', (error) => {
    pageErrors.push({ message: error.message });
  });

  return {
    flush(): StepCapture {
      const captured: StepCapture = {
        consoleEntries: consoleEntries.slice(0, TOKEN_GUARDS.MAX_CONSOLE_ERRORS),
        networkFailures: networkFailures.slice(0, TOKEN_GUARDS.MAX_NETWORK_ERRORS),
        pageErrors: [...pageErrors],
      };

      consoleEntries = [];
      networkFailures = [];
      pageErrors = [];

      return captured;
    },
  };
}
