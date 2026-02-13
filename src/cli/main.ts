#!/usr/bin/env node

/**
 * promptqa CLI entry point.
 * Thin wrapper — all logic delegated to core.
 */

import 'dotenv/config';
import { Command } from 'commander';

import { registerTestCommand, registerRunCommand } from './run.js';

const program = new Command();

program
  .name('promptqa')
  .description(
    'Prompt-driven web app test runner. Generate browser tests from natural language, execute with Playwright, evaluate with LLM.',
  )
  .version('0.1.0');

registerTestCommand(program);
registerRunCommand(program);

program.parse();
