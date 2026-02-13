#!/usr/bin/env node

/**
 * promptqa CLI entry point.
 * Thin wrapper — all logic delegated to core.
 */

import { Command } from "commander";

const program = new Command();

program
  .name("promptqa")
  .description(
    "Prompt-driven web app test runner. Generate browser tests from natural language, execute with Playwright, evaluate with LLM.",
  )
  .version("0.1.0");

program.parse();
