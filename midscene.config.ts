import { fileURLToPath } from 'node:url';
import type { NodeExecutionContext } from '@midscene/test';
import {
  defineFileSetup,
  defineProjectSetup,
  defineTestProject,
} from '@midscene/test/config';
import { createMidsceneNodes } from '@midscene/test/midscene';
import { PlaywrightAgent } from '@midscene/web/playwright/agent';
import { config as loadEnv } from 'dotenv';
import { type Browser, type Page, chromium } from 'playwright';
import { createTodoNodes } from './nodes/todo';

loadEnv({ path: fileURLToPath(new URL('.env', import.meta.url)) });

interface FileContext {
  page: Page;
  agent?: PlaywrightAgent;
}

interface ProjectContext {
  browser: Browser;
}

// Create the Agent on first use; reuse it within this file.
//
// Robust locate chain (priority: explicit xpath -> locate cache -> AI visual):
// - Tier 1: pass `xpath` in YAML locate nodes (aiTap/aiInput/...); resolved and
//   rect-validated via the browser, cache and model are skipped entirely.
// - Tier 2: locate prompts are cached to ./midscene_run/cache/<id>.cache.yaml;
//   on reuse each cached xpath is re-evaluated against the live DOM and must
//   resolve to a visible element with a valid rect, otherwise it is a miss.
// - Tier 3: on cache miss the AI visual model locates the element from the
//   screenshot, and the fresh point -> xpaths are written back to the cache.
// Set MIDSCENE_LOCATE_CACHE=false to disable caching (debug / fresh AI runs).
const getAgent = ({ context }: NodeExecutionContext<unknown, FileContext>) => {
  context.agent ??= new PlaywrightAgent(context.page, {
    cache:
      process.env.MIDSCENE_LOCATE_CACHE === 'false'
        ? false
        : { id: 'web-locate-chain' },
  });
  return context.agent;
};

// Once per project: keep the shared Browser until every file has cleaned up.
const setup = defineProjectSetup<ProjectContext>({
  name: 'web',
  async setup({ env, onTeardown }) {
    const browser = await chromium.launch({
      headless: env.HEADLESS !== 'false',
    });
    onTeardown(() => browser.close());
    return { browser };
  },
});

// Before each file's beforeAll: create its session, page, and Node context.
const fileSetup = defineFileSetup<FileContext, ProjectContext>({
  name: 'web-file',
  async setup({ projectContext, signal, onTeardown }) {
    if (!projectContext)
      throw new Error('Web Project setup did not create a browser.');
    const browserContext = await projectContext.browser.newContext();
    onTeardown(() => browserContext.close());
    signal.throwIfAborted();
    const page = await browserContext.newPage();
    const context: FileContext = { page };
    onTeardown(async () => {
      await context.agent?.destroy();
    });
    return context;
  },
});

export default defineTestProject<FileContext, ProjectContext>({
  projects: [
    {
      name: 'web',
      setup,
      fileSetup,
      files: { include: ['cases/**/*.{yaml,yml}'] },
    },
  ],
  nodes: [
    ...createTodoNodes<FileContext>({ getPage: (context) => context.page }),
    ...createMidsceneNodes<FileContext>({
      agentClass: PlaywrightAgent,
      getAgent,
    }),
  ],
  test: { maxConcurrentFiles: 1, bail: 1, testTimeout: 600_000 },
});
