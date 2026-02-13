import type { Page } from 'playwright';

import type { InteractiveElement, PageSnapshot } from '../schema/index.js';
import { TIMEOUTS } from '../config/defaults.js';

const PRESCAN_TEXT_LIMIT = 4_000;

// ── Public API ───────────────────────────────────────────────

/**
 * Navigate to `url` and extract a structured snapshot of the page
 * for the planner. Pure DOM extraction — no AI.
 */
export async function prescanPage(
  page: Page,
  url: string,
): Promise<PageSnapshot> {
  await page.goto(url, {
    timeout: TIMEOUTS.NAVIGATION_TIMEOUT,
    waitUntil: 'domcontentloaded',
  });

  const [title, visibleText, extracted] = await Promise.all([
    page.title(),
    page
      .innerText('body')
      .then((t) => t.slice(0, PRESCAN_TEXT_LIMIT), () => ''),
    page.evaluate(extractFromDOM),
  ]);

  const snapshot: PageSnapshot = {
    url: page.url(),
    title,
    visibleText,
    elements: extracted.elements,
  };

  if (extracted.metaDescription) {
    snapshot.metaDescription = extracted.metaDescription;
  }

  return snapshot;
}

// ── Browser-context extraction ───────────────────────────────
// This function is serialized and executed inside the browser.
// It must NOT reference any outer-scope variables.

function extractFromDOM(): {
  metaDescription: string | null;
  elements: InteractiveElement[];
} {
  function attr(el: Element, name: string): string | undefined {
    return el.getAttribute(name) ?? undefined;
  }

  function textOf(el: Element): string | undefined {
    const t = el.textContent?.trim();
    return t || undefined;
  }

  function getLabel(el: Element): string | undefined {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    const id = el.getAttribute('id');
    if (id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const labelText = labelEl?.textContent?.trim();
      if (labelText) return labelText;
    }

    const parent = el.closest('label');
    const parentText = parent?.textContent?.trim();
    if (parentText) return parentText;

    return undefined;
  }

  const seen = new Set<Element>();
  const elements: InteractiveElement[] = [];

  function add(el: Element, data: InteractiveElement): void {
    if (seen.has(el)) return;
    seen.add(el);
    elements.push(data);
  }

  // Buttons (native + ARIA role)
  document.querySelectorAll('button, [role="button"]').forEach((el) => {
    add(el, {
      tag: 'button',
      text: textOf(el),
      testId: attr(el, 'data-testid'),
      name: attr(el, 'name'),
    });
  });

  // Links
  document.querySelectorAll('a[href]').forEach((el) => {
    add(el, {
      tag: 'a',
      text: textOf(el),
      testId: attr(el, 'data-testid'),
      href: attr(el, 'href'),
    });
  });

  // Inputs (text, password, email, file, etc.)
  document.querySelectorAll('input').forEach((el) => {
    add(el, {
      tag: 'input',
      type: el.type || undefined,
      text: getLabel(el),
      testId: attr(el, 'data-testid'),
      name: attr(el, 'name'),
      placeholder: attr(el, 'placeholder'),
    });
  });

  // Selects
  document.querySelectorAll('select').forEach((el) => {
    add(el, {
      tag: 'select',
      text: getLabel(el),
      testId: attr(el, 'data-testid'),
      name: attr(el, 'name'),
      options: Array.from(el.options).map((o) => o.text.trim() || o.value),
    });
  });

  // Textareas
  document.querySelectorAll('textarea').forEach((el) => {
    add(el, {
      tag: 'textarea',
      text: getLabel(el),
      testId: attr(el, 'data-testid'),
      name: attr(el, 'name'),
      placeholder: attr(el, 'placeholder'),
    });
  });

  const metaEl = document.querySelector('meta[name="description"]');
  const metaDescription = metaEl?.getAttribute('content') ?? null;

  return { metaDescription, elements };
}
