# CLAUDE.md — promptqa

## Project Overview
promptqa is a prompt-driven web app test runner CLI tool. It takes a URL + natural language test prompt, generates browser test steps via LLM, executes them with Playwright, and produces structured reports.

## Tech Stack
- Node.js 20+
- TypeScript (strict mode)
- ESM modules
- Playwright (browser automation)
- Commander (CLI)
- Zod (schema validation)
- dotenv (env config)

## Architecture Rules

### Determinism Rule (CRITICAL)
LLM calls are allowed ONLY in:
- `src/core/planner.ts`
- `src/core/evaluator.ts`

LLM calls are NEVER allowed in:
- browser runner
- capture layer
- selector resolution
- reporter
- CLI
- summary decision

If you're about to add an LLM call outside planner/evaluator — stop and rethink.

### Module Boundaries
- No cross-layer imports (browser must not import from cli, core must not import from report)
- CLI is a thin wrapper — zero business logic
- All core logic must be testable without CLI
- Schema-first: define Zod schemas before implementation

### Import Order
1. Node built-ins
2. External packages
3. Internal modules (absolute paths from src/)

## Code Style
- TypeScript strict mode — no `any`, no type assertions unless absolutely necessary
- Pure functions where possible — no side effects in core modules
- All interfaces and types defined in `src/schema/`
- Error handling: throw typed errors, never swallow errors silently
- Use async/await, no raw promises or callbacks
- No classes unless genuinely needed — prefer functions + interfaces

## File Structure
```
src/
├── cli/          # Commander CLI wrapper only
├── config/       # Defaults, config loader, env
├── core/         # Planner, evaluator, agentLoop, summary
├── browser/      # Runner, capture, selectors, prescan, auth
├── llm/          # LLM client interface + providers
├── schema/       # All types, interfaces, Zod schemas
└── report/       # Markdown + JSON report generators
prompts/          # LLM prompt templates (.txt files)
examples/         # Example test configs
```

## Naming Conventions
- Files: `camelCase.ts`
- Types/Interfaces: `PascalCase`
- Functions: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Zod schemas: `camelCaseSchema` (e.g., `stepSchema`, `evaluationResultSchema`)

## Testing
- Unit tests go next to source files: `module.test.ts`
- Use the mock LLM provider for tests — never call real LLM in tests
- Test modules in isolation — runner without planner, evaluator without browser

## Common Mistakes to Avoid
- Do NOT hardcode CSS selectors anywhere — always use SelectorHint + resolveSelector
- Do NOT let the LLM decide the run summary — summary is deterministic (any FAIL → FAIL)
- Do NOT send full page text to LLM — truncate to 8k chars
- Do NOT retry on timeouts or crashes — only retry on element_not_found or LLM parse errors
- Do NOT mix capture logic with evaluation logic
- Do NOT add interactive prompts in CLI — this is a non-interactive tool for automation

## Environment Variables
```
LLM_PROVIDER=openai    # or "mock" for testing
OPENAI_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

## Build & Run
```bash
npm run build          # TypeScript compilation
npm run dev            # Dev mode with watch
npx playwright install # Install browser engines (first time only)
```

## When Adding a New Feature
1. Define types/interfaces in `src/schema/` first
2. Add Zod validation
3. Implement the module
4. Add unit test
5. Wire into agentLoop if needed
6. Update CLI flags if user-facing
