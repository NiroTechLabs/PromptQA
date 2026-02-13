import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';

import { fileConfigSchema } from '../schema/config.js';
import type { FileConfig } from '../schema/config.js';

// ── Public API ──────────────────────────────────────────────

/**
 * Load and validate a `.promptqa.yaml` (or JSON) config file.
 * Throws a descriptive error if the file is missing or invalid.
 */
export async function loadConfigFile(configPath: string): Promise<FileConfig> {
  const raw = await readFile(configPath, 'utf-8');

  const parsed: unknown = configPath.endsWith('.json')
    ? JSON.parse(raw)
    : parseYaml(raw);

  return fileConfigSchema.parse(parsed);
}
