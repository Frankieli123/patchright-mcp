// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { createRequire } from "module";
import * as vm from "vm";

// Import the Patchright library
// This is the Node.js version of Patchright which is a stealth browser automation tool
// based on Playwright but with anti-detection features
import { chromium, Browser, BrowserContext, Page } from "patchright";

// Create temp directory for screenshots
const TEMP_DIR = path.join(os.tmpdir(), "patchright-mcp");
const PROFILES_DIR = path.join(TEMP_DIR, "profiles");
const DOWNLOADS_DIR = path.join(TEMP_DIR, "downloads");
const TRACES_DIR = path.join(TEMP_DIR, "traces");
const PDFS_DIR = path.join(TEMP_DIR, "pdfs");

const tracingSessions = new Map<string, { zipPath: string; startedAt: number }>();

// Ensure temp directory exists
(async () => {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.mkdir(PROFILES_DIR, { recursive: true });
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
    await fs.mkdir(TRACES_DIR, { recursive: true });
    await fs.mkdir(PDFS_DIR, { recursive: true });
    console.error(`Temp directory created at: ${TEMP_DIR}`);
    console.error(`Profiles directory: ${PROFILES_DIR}`);
    console.error(`Downloads directory: ${DOWNLOADS_DIR}`);
    console.error(`Traces directory: ${TRACES_DIR}`);
    console.error(`PDFs directory: ${PDFS_DIR}`);
  } catch (error) {
    console.error(`Error creating temp directory: ${error}`);
  }
})();

// Keep track of browser instances and pages
interface BrowserInstance {
  browser: Browser | null;
  context: BrowserContext;
  pages: Map<string, Page>;
  pageIdByPage: Map<Page, string>;
  activePageId: string;
  consoleMessages: Map<string, string[]>;
  recentConsoleMessages: Map<string, string[]>;
  downloads: Map<string, Array<{ suggestedFilename: string; outputFile: string; finished: boolean }>>;
  networkEvents: Map<string, Array<{ ts: number; type: "request" | "response"; url: string; method?: string; status?: number; resourceType?: string }>>;
  headless: boolean;
  isPersistent: boolean;
  profile?: string;
  userDataDir?: string;
  cleanupUserDataDir?: boolean;
}

const browserInstances = new Map<string, BrowserInstance>();
const require = createRequire(import.meta.url);

function loadSecretsFromEnv(): Record<string, string> | undefined {
  const raw = process.env.PATCHRIGHT_MCP_SECRETS_JSON ?? process.env.PATCHRIGHT_MCP_SECRETS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" && v)
      .map(([k, v]) => [String(k), String(v)] as const);
    return Object.fromEntries(entries);
  } catch {
    console.error("Failed to parse PATCHRIGHT_MCP_SECRETS_JSON/PATCHRIGHT_MCP_SECRETS; expected JSON object.");
    return undefined;
  }
}

const MCP_SECRETS = loadSecretsFromEnv();

function sanitizeProfileName(name: string): string {
  const trimmed = name.trim() || "default";
  const cleaned = trimmed.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 64) || "default";
}

function profileBrowserId(profile: string): string {
  return `profile:${sanitizeProfileName(profile)}`;
}

function sanitizeFileName(input: string, fallbackBase: string, ext?: string): string {
  const raw = input.trim();
  const base = path.basename(raw || fallbackBase || `file-${Date.now()}`);
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/\.+$/g, "");
  if (!ext) return cleaned || fallbackBase || `file-${Date.now()}`;
  const withExt = cleaned.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? cleaned : `${cleaned}.${ext}`;
  return withExt || `${fallbackBase}.${ext}`;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function pushBounded<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}

function registerPage(instance: BrowserInstance, page: Page): string {
  const existing = instance.pageIdByPage.get(page);
  if (existing) return existing;

  const pageId = randomUUID();
  instance.pageIdByPage.set(page, pageId);
  instance.pages.set(pageId, page);
  instance.activePageId = pageId;
  if (!instance.consoleMessages.has(pageId)) instance.consoleMessages.set(pageId, []);
  if (!instance.recentConsoleMessages.has(pageId)) instance.recentConsoleMessages.set(pageId, []);
  if (!instance.downloads.has(pageId)) instance.downloads.set(pageId, []);
  if (!instance.networkEvents.has(pageId)) instance.networkEvents.set(pageId, []);

  page.on("close", () => {
    instance.pages.delete(pageId);
    instance.consoleMessages.delete(pageId);
    instance.networkEvents.delete(pageId);
    instance.pageIdByPage.delete(page);
    if (instance.activePageId === pageId) {
      const next = instance.pages.keys().next();
      instance.activePageId = next.done ? "" : next.value;
    }
  });

  page.on("console", (msg) => {
    const arr = instance.consoleMessages.get(pageId);
    const recent = instance.recentConsoleMessages.get(pageId);
    if (!arr) return;
    const location = (() => {
      try {
        const loc = msg.location();
        return loc && loc.url ? ` @ ${loc.url}:${loc.lineNumber ?? 0}:${loc.columnNumber ?? 0}` : "";
      } catch {
        return "";
      }
    })();
    const line = `[${msg.type()}] ${msg.text()}${location}`;
    pushBounded(arr, line, 200);
    if (recent) pushBounded(recent, line, 200);
  });

  page.on("download", (download) => {
    const list = instance.downloads.get(pageId);
    if (!list) return;

    const suggested = (() => {
      try {
        return download.suggestedFilename();
      } catch {
        return "download.bin";
      }
    })();

    const sanitized = sanitizeFileName(suggested, "download");
    const ext = path.extname(sanitized);
    const base = ext ? sanitized.slice(0, -ext.length) : sanitized;
    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const fileName = `${base}-${suffix}${ext}`;
    const outputFile = path.join(DOWNLOADS_DIR, fileName);
    const entry = { suggestedFilename: suggested, outputFile, finished: false };
    pushBounded(list, entry, 50);

    void (async () => {
      try {
        await ensureDir(DOWNLOADS_DIR);
        await download.saveAs(outputFile);
        entry.finished = true;
      } catch {
        // ignore
      }
    })();
  });

  page.on("request", (req) => {
    const arr = instance.networkEvents.get(pageId);
    if (!arr) return;
    pushBounded(
      arr,
      {
        ts: Date.now(),
        type: "request",
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType()
      },
      500
    );
  });

  page.on("response", (res) => {
    const arr = instance.networkEvents.get(pageId);
    if (!arr) return;
    pushBounded(
      arr,
      {
        ts: Date.now(),
        type: "response",
        url: res.url(),
        status: res.status()
      },
      500
    );
  });

  return pageId;
}

async function getOrCreateSession(options: {
  browserId?: string;
  profile: string;
  isolated: boolean;
  headless: boolean;
  launchArgs: string[];
}): Promise<{ browserId: string; instance: BrowserInstance; wasReused: boolean }> {
  const requestedBrowserId = options.browserId?.trim() || undefined;
  const profileKeyFromId = requestedBrowserId?.startsWith("profile:")
    ? sanitizeProfileName(requestedBrowserId.slice("profile:".length))
    : undefined;
  const profileKey = profileKeyFromId ?? sanitizeProfileName(options.profile);

  const resolvedBrowserId = requestedBrowserId
    ? requestedBrowserId.startsWith("profile:")
      ? profileBrowserId(profileKey)
      : requestedBrowserId
    : options.isolated
      ? randomUUID()
      : profileBrowserId(profileKey);

  let instance = browserInstances.get(resolvedBrowserId);
  let wasReused = true;
  if (!instance) {
    wasReused = false;
    if (!options.isolated && resolvedBrowserId.startsWith("profile:")) {
      await ensureDir(PROFILES_DIR);
      const userDataDir = path.join(PROFILES_DIR, profileKey);
      await ensureDir(userDataDir);

      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: options.headless,
        args: options.launchArgs,
        viewport: null
      });
      const browser = context.browser();

      instance = {
        browser,
        context,
        pages: new Map(),
        pageIdByPage: new Map(),
        activePageId: "",
        consoleMessages: new Map(),
        recentConsoleMessages: new Map(),
        downloads: new Map(),
        networkEvents: new Map(),
        headless: options.headless,
        isPersistent: true,
        profile: profileKey,
        userDataDir
      };
      browserInstances.set(resolvedBrowserId, instance);

      for (const p of context.pages()) registerPage(instance, p);
      if (!context.pages().length) registerPage(instance, await context.newPage());
      context.on("page", (p) => registerPage(instance!, p));
    } else {
      const browser = await chromium.launch({
        headless: options.headless,
        args: options.launchArgs
      });
      const context = await browser.newContext({
        viewport: null
      });

      instance = {
        browser,
        context,
        pages: new Map(),
        pageIdByPage: new Map(),
        activePageId: "",
        consoleMessages: new Map(),
        recentConsoleMessages: new Map(),
        downloads: new Map(),
        networkEvents: new Map(),
        headless: options.headless,
        isPersistent: false
      };
      browserInstances.set(resolvedBrowserId, instance);

      registerPage(instance, await context.newPage());
      context.on("page", (p) => registerPage(instance!, p));
    }
  }

  if (instance.headless !== options.headless) {
    throw new Error(
      `Browser is already running with headless=${instance.headless}; close it first to relaunch with headless=${options.headless}.`
    );
  }

  return { browserId: resolvedBrowserId, instance, wasReused };
}

function getPage(
  browserId: string,
  pageId?: string
): { pageId: string; page: Page; instance: BrowserInstance } {
  const instance = browserInstances.get(browserId);
  if (!instance) {
    throw new Error(`Browser instance not found: ${browserId}`);
  }

  if (pageId) {
    const page = instance.pages.get(pageId);
    if (!page) {
      throw new Error(`Page not found: ${pageId}`);
    }
    instance.activePageId = pageId;
    return { pageId, page, instance };
  }

  const active = instance.pages.get(instance.activePageId);
  if (active) {
    return { pageId: instance.activePageId, page: active, instance };
  }

  const first = instance.pages.entries().next();
  if (!first.done) {
    const [firstPageId, firstPage] = first.value;
    instance.activePageId = firstPageId;
    return { pageId: firstPageId, page: firstPage, instance };
  }

  throw new Error(`No pages found for browser instance: ${browserId}`);
}

function formatEvalResult(result: unknown): string {
  if (result === undefined) return "undefined";
  if (result === null) return "null";

  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

type ImageType = "png" | "jpeg";

let pwUtilsBundle: any | undefined;
let pwUtils: any | undefined;

function scaleImageToFitMessage(buffer: Buffer, imageType: ImageType): Buffer {
  try {
    if (!pwUtilsBundle) pwUtilsBundle = require("patchright-core/lib/utilsBundle");
    if (!pwUtils) pwUtils = require("patchright-core/lib/utils");

    const image =
      imageType === "png"
        ? pwUtilsBundle.PNG.sync.read(buffer)
        : pwUtilsBundle.jpegjs.decode(buffer, { maxMemoryUsageInMB: 512 });

    const pixels = image.width * image.height;
    const shrink = Math.min(1568 / image.width, 1568 / image.height, Math.sqrt((1.15 * 1024 * 1024) / pixels));
    if (shrink > 1) return buffer;

    const width = (image.width * shrink) | 0;
    const height = (image.height * shrink) | 0;
    const scaledImage = pwUtils.scaleImageToSize(image, { width, height });

    return imageType === "png" ? pwUtilsBundle.PNG.sync.write(scaledImage) : pwUtilsBundle.jpegjs.encode(scaledImage, 80).data;
  } catch {
    return buffer;
  }
}

async function snapshotForAI(page: Page): Promise<{ full: string; incremental?: string }> {
  const fn = (page as any)._snapshotForAI as ((options: { track: string }) => Promise<any>) | undefined;
  if (typeof fn !== "function") {
    throw new Error("This Patchright build does not expose page._snapshotForAI().");
  }
  const snapshot = await fn.call(page, { track: "response" });
  if (!snapshot || typeof snapshot.full !== "string") {
    throw new Error("Unexpected snapshot format from page._snapshotForAI().");
  }
  return { full: snapshot.full, incremental: typeof snapshot.incremental === "string" ? snapshot.incremental : undefined };
}

async function ariaSnapshotFallback(page: Page, maxNodes: number): Promise<string> {
  const snapshot = (await page.evaluate(
    ({ maxNodes }) => {
      const out: string[] = [];
      let count = 0;

      const isHidden = (el: Element): boolean => {
        if ((el as any).hidden) return true;
        if (el.getAttribute("aria-hidden") === "true") return true;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return true;
        return false;
      };

      const tagRole = (el: Element): string | null => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;

        const tag = el.tagName.toLowerCase();
        if (tag === "a" && (el as HTMLAnchorElement).href) return "link";
        if (tag === "button") return "button";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "img") return "img";
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "nav") return "navigation";
        if (tag === "main") return "main";
        if (tag === "form") return "form";
        if (tag === "ul" || tag === "ol") return "list";
        if (tag === "li") return "listitem";
        if (tag === "table") return "table";
        if (tag === "tr") return "row";
        if (tag === "th") return "columnheader";
        if (tag === "td") return "cell";
        if (tag !== "input") return null;

        const type = ((el as HTMLInputElement).type || "").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "button" || type === "submit" || type === "reset") return "button";
        if (type === "range") return "slider";
        if (type === "search") return "searchbox";
        if (
          ["email", "number", "password", "tel", "text", "url", "date", "datetime-local", "month", "time", "week"].includes(type)
        ) {
          return "textbox";
        }
        return "input";
      };

      const nameFor = (el: Element): string => {
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel.trim();

        const ariaLabelledBy = el.getAttribute("aria-labelledby");
        if (ariaLabelledBy) {
          const parts = ariaLabelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() || "")
            .filter(Boolean);
          if (parts.length) return parts.join(" ");
        }

        if (el instanceof HTMLImageElement) {
          const alt = el.getAttribute("alt");
          if (alt) return alt.trim();
        }

        if (el instanceof HTMLInputElement) {
          const byId = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
          const parentLabel = el.closest("label");
          const labelText = (byId || parentLabel)?.textContent?.trim();
          if (labelText) return labelText;
          const placeholder = el.getAttribute("placeholder");
          if (placeholder) return placeholder.trim();
        }

        const title = el.getAttribute("title");
        if (title) return title.trim();

        const text = (el as HTMLElement).innerText?.trim() || el.textContent?.trim() || "";
        return text.replace(/\s+/g, " ").slice(0, 120);
      };

      const shouldInclude = (el: Element, role: string | null, name: string): boolean => {
        if (el === document.body) return true;
        if (role) return true;
        if (name) return true;
        const tag = el.tagName.toLowerCase();
        return tag === "body" || tag === "main" || tag === "nav";
      };

      const walk = (el: Element, depth: number) => {
        if (count >= maxNodes) return;
        if (isHidden(el)) return;

        const role = tagRole(el);
        const name = nameFor(el);
        const include = shouldInclude(el, role, name);
        const nextDepth = include ? depth + 1 : depth;

        if (include) {
          const indent = "  ".repeat(depth);
          const label = role || el.tagName.toLowerCase();
          const suffix = name ? `: ${name}` : "";
          out.push(`${indent}${label}${suffix}`);
          count++;
          if (count >= maxNodes) return;
        }

        for (const child of Array.from(el.children)) {
          walk(child, nextDepth);
          if (count >= maxNodes) return;
        }
      };

      walk(document.body, 0);

      if (count >= maxNodes) out.push(`... (truncated, maxNodes=${maxNodes})`);
      return out.join("\\n");
    },
    { maxNodes }
  )) as string;

  return snapshot;
}

async function refLocator(page: Page, params: { element: string; ref: string }): Promise<{ locator: any; resolved: string }> {
  const snapshotFn = (page as any)._snapshotForAI as unknown;
  if (typeof snapshotFn !== "function") {
    throw new Error("Ref-based actions require page._snapshotForAI() support. Use selector-based tools or upgrade Patchright.");
  }
  if (!pwUtils) pwUtils = require("patchright-core/lib/utils");

  try {
    let locator = (page as any).locator(`aria-ref=${params.ref}`);
    if (typeof locator?.describe === "function") locator = locator.describe(params.element);

    const resolve = locator?._resolveSelector as (() => Promise<{ resolvedSelector: string }>) | undefined;
    if (typeof resolve !== "function") {
      return { locator, resolved: `locator(${JSON.stringify(`aria-ref=${params.ref}`)})` };
    }

    const { resolvedSelector } = await resolve.call(locator);
    const resolved = pwUtils.asLocator("javascript", resolvedSelector);
    return { locator, resolved };
  } catch {
    throw new Error(`Ref ${params.ref} not found in the current page snapshot. Try capturing new snapshot.`);
  }
}

type ActionTarget = { kind: "ref"; element: string; ref: string } | { kind: "selector"; selector: string };

const actionTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ref"),
    element: z.string().describe("Human-readable element description used to obtain permission to interact with the element"),
    ref: z.string().describe("Exact target element reference from the page snapshot")
  }),
  z.object({
    kind: z.literal("selector"),
    selector: z.string().describe("Fallback selector (legacy)")
  })
]);

async function resolveActionLocator(
  page: Page,
  params: { target?: ActionTarget; element?: string; ref?: string; selector?: string },
  options?: { required?: boolean }
): Promise<{ locator: any; resolved: string } | null> {
  const required = options?.required !== false;

  if (params.target) {
    if (params.target.kind === "ref") return refLocator(page, { element: params.target.element, ref: params.target.ref });
    if (!pwUtils) pwUtils = require("patchright-core/lib/utils");
    return { locator: page.locator(params.target.selector), resolved: pwUtils.asLocator("javascript", params.target.selector) };
  }

  const usingRef = Boolean(params.ref && params.element);
  const usingSelector = Boolean(params.selector && params.selector.trim());

  if (usingRef) return refLocator(page, { element: params.element!, ref: params.ref! });
  if (usingSelector) {
    if (!pwUtils) pwUtils = require("patchright-core/lib/utils");
    return { locator: page.locator(params.selector!), resolved: pwUtils.asLocator("javascript", params.selector!) };
  }

  if (required) {
    throw new Error(
      "Provide `target` ({kind:'ref', element, ref} | {kind:'selector', selector}) or legacy `selector` or legacy `element`+`ref`."
    );
  }
  return null;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type ToolResult = { content: ToolContent[]; isError?: boolean };

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function trimText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

function renderSection(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `### ${title}\n${trimmed}\n`;
}

function renderCodeSection(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return "";
  return renderSection("Ran Playwright code", `\`\`\`js\n${trimmed}\n\`\`\``);
}

function renderPageStateSection(page: { url: string; title?: string }, snapshot?: { text: string; language?: string }): string {
  const lines: string[] = [];
  lines.push(`- Page URL: ${page.url}`);
  lines.push(`- Page Title: ${page.title ?? ""}`);
  if (snapshot) {
    const lang = snapshot.language ?? "yaml";
    lines.push(`- Page Snapshot:`);
    lines.push(`\`\`\`${lang}`);
    lines.push(snapshot.text.trimEnd());
    lines.push("```");
  }
  return renderSection("Page state", lines.join("\n"));
}

function pwRespond(params: {
  result?: string;
  code?: string;
  tabs?: string;
  consoleMessages?: string;
  downloads?: string;
  modalState?: string;
  page?: { url: string; title?: string };
  snapshot?: { text: string; language?: string };
  images?: Array<{ mimeType: string; data: Buffer }>;
  isError?: boolean;
}): ToolResult {
  const parts: string[] = [];
  if (params.result) parts.push(renderSection("Result", params.result));
  if (params.code) parts.push(renderCodeSection(params.code));
  if (params.tabs) parts.push(renderSection("Open tabs", params.tabs));
  if (params.modalState) parts.push(renderSection("Modal state", params.modalState));
  if (params.consoleMessages) parts.push(renderSection("New console messages", params.consoleMessages));
  if (params.downloads) parts.push(renderSection("Downloads", params.downloads));
  if (params.page) parts.push(renderPageStateSection(params.page, params.snapshot));

  const text = parts.filter(Boolean).join("\n").trimEnd() || "### Result\n";
  const content: ToolContent[] = [{ type: "text", text }];

  for (const img of params.images ?? []) {
    content.push({
      type: "image",
      data: img.data.toString("base64"),
      mimeType: img.mimeType
    });
  }

  if (MCP_SECRETS) {
    for (const item of content) {
      if (item.type !== "text") continue;
      for (const [secretName, secretValue] of Object.entries(MCP_SECRETS)) {
        if (!secretValue) continue;
        item.text = item.text.split(secretValue).join(`<secret>${secretName}</secret>`);
      }
    }
  }

  return params.isError ? { content, isError: true } : { content };
}

function pwOk(
  result: string,
  options?: {
    code?: string;
    tabs?: string;
    consoleMessages?: string;
    downloads?: string;
    modalState?: string;
    page?: { url: string; title?: string };
    snapshot?: { text: string; language?: string };
    images?: Array<{ mimeType: string; data: Buffer }>;
  }
): ToolResult {
  return pwRespond({
    result,
    code: options?.code,
    tabs: options?.tabs,
    consoleMessages: options?.consoleMessages,
    downloads: options?.downloads,
    modalState: options?.modalState,
    page: options?.page,
    snapshot: options?.snapshot,
    images: options?.images
  });
}

function pwError(
  prefix: string,
  error: unknown,
  options?: { code?: string; page?: { url: string; title?: string }; snapshot?: { text: string; language?: string } }
): ToolResult {
  const message = `${prefix}: ${stringifyError(error)}`;
  return pwRespond({ result: message, code: options?.code, page: options?.page, snapshot: options?.snapshot, isError: true });
}

const server = new McpServer({
  name: "patchright-lite",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Tool 1: Browse - Navigate and snapshot (reuses a persistent profile by default)
server.tool(
  "browse",
  "Browse to a URL (reuses a persistent profile by default) and return the page title and visible text",
  {
    url: z.string().url().describe("The URL to navigate to"),
    headless: z.boolean().default(false).describe("Whether to run the browser in headless mode"),
    waitFor: z.number().default(1000).describe("Time to wait after page load (milliseconds)"),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("load").describe("Navigation wait condition"),
    profile: z
      .string()
      .default("default")
      .describe("Persistent profile name (reused across calls and restarts; pass different names for multi-account isolation)"),
    isolated: z
      .boolean()
      .default(false)
      .describe("Start a temporary isolated session (ignores profile; does not persist)"),
    browserId: z
      .string()
      .optional()
      .describe("Reuse an existing browserId instead of profile/isolated (useful for re-snapshotting the same page)"),
    newPage: z.boolean().default(false).describe("Open a new tab/page in the chosen session instead of reusing the active page")
  },
  async ({
    url,
    headless,
    waitFor,
    waitUntil,
    profile,
    isolated,
    browserId,
    newPage
  }: {
    url: string;
    headless: boolean;
    waitFor: number;
    waitUntil: "load" | "domcontentloaded" | "networkidle";
    profile: string;
    isolated: boolean;
    browserId?: string;
    newPage: boolean;
  }) => {
    try {
      const launchArgs = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu"
      ];

      const session = await getOrCreateSession({
        browserId,
        profile,
        isolated,
        headless,
        launchArgs
      });

      const resolvedBrowserId = session.browserId;
      const instance = session.instance;
      const wasReused = session.wasReused;

      let pageId: string;
      let page: Page;
      if (newPage) {
        page = await instance.context.newPage();
        pageId = registerPage(instance, page);
      } else {
        const resolved = getPage(resolvedBrowserId);
        pageId = resolved.pageId;
        page = resolved.page;
      }

      await page.goto(url, { waitUntil });
      await page.waitForTimeout(waitFor);
      
      // Get page title
      const title = await page.title();
      
      // Extract visible text with stealth (isolated context)
      // This ensures the page doesn't detect us using Runtime.evaluate
      const visibleText = await page.evaluate(`
        Array.from(document.querySelectorAll('body, body *'))
          .filter(element => {
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          })
          .map(element => element.textContent)
          .filter(text => text && text.trim().length > 0)
          .join('\\n')
      `) as string;
      
      // Take a screenshot
      const screenshotPath = path.join(TEMP_DIR, `screenshot-${pageId}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
      
      return pwOk(
        `Successfully browsed to: ${url}\n\nPage Title: ${title}\n\nVisible Text Preview:\n${visibleText.substring(0, 1500)}${
          visibleText.length > 1500 ? "..." : ""
        }\n\nBrowser ID: ${resolvedBrowserId}\nPage ID: ${pageId}\nPersistent Profile: ${
          instance.isPersistent ? instance.profile : "no"
        }\nReused Session: ${wasReused}\nScreenshot saved to: ${screenshotPath}`
      );
    } catch (error) {
      return pwError("Failed to browse", error);
    }
  }
);

// Tool: browser_open - Playwright MCP compatible "open URL" helper (best-effort)
server.tool(
  "browser_open",
  "Open a URL in the browser",
  {
    url: z.string().describe("The URL to open"),
    headed: z.boolean().optional().describe("Run browser in headed mode"),
    profile: z
      .string()
      .default("default")
      .describe("Persistent profile name (reused across calls and restarts; pass different names for multi-account isolation)"),
    isolated: z.boolean().default(false).describe("Start a temporary isolated session (ignores profile; does not persist)"),
    browserId: z
      .string()
      .optional()
      .describe("Reuse an existing browserId instead of profile/isolated (supports browserId starting with profile:)"),
    newPage: z.boolean().default(false).describe("Open a new tab/page instead of reusing the active page"),
    waitFor: z.number().default(1000).describe("Time to wait after page load (milliseconds)"),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("load").describe("Navigation wait condition")
  },
  async ({
    url,
    headed,
    profile,
    isolated,
    browserId,
    newPage,
    waitFor,
    waitUntil
  }: {
    url: string;
    headed?: boolean;
    profile: string;
    isolated: boolean;
    browserId?: string;
    newPage: boolean;
    waitFor: number;
    waitUntil: "load" | "domcontentloaded" | "networkidle";
  }) => {
    try {
      const launchArgs = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu"
      ];

      let normalized = url;
      try {
        // eslint-disable-next-line no-new
        new URL(normalized);
      } catch {
        normalized = normalized.startsWith("localhost") ? `http://${normalized}` : `https://${normalized}`;
      }

      const headless = headed === true ? false : headed === false ? true : false;

      const session = await getOrCreateSession({
        browserId,
        profile,
        isolated,
        headless,
        launchArgs
      });

      const resolvedBrowserId = session.browserId;
      const instance = session.instance;

      let resolvedPageId: string;
      let page: Page;
      if (newPage) {
        page = await instance.context.newPage();
        resolvedPageId = registerPage(instance, page);
      } else {
        const resolved = getPage(resolvedBrowserId);
        resolvedPageId = resolved.pageId;
        page = resolved.page;
      }

      const response = await page.goto(normalized, { waitUntil });
      await page.waitForTimeout(waitFor);

      const title = await page.title().catch(() => "");
      const currentUrl = page.url();
      const screenshotPath = path.join(TEMP_DIR, `screenshot-${resolvedPageId}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });

      return pwOk(
        `Opened: ${url}\\n\\nCurrent URL: ${currentUrl}\\nPage Title: ${title}\\nStatus: ${
          response ? response.status() : "unknown"
        }\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolvedPageId}\\nScreenshot saved to: ${screenshotPath}`
      );
    } catch (error) {
      return pwError("Failed to open", error);
    }
  }
);

// Tool 1a: browser_tabs - List open pages/tabs
server.tool(
  "browser_tabs",
  "List, create, close, or select a browser tab.",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    action: z.enum(["list", "new", "close", "select"]).default("list").describe("Operation to perform"),
    index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Tab index used for close/select. If omitted for close, current tab is closed.")
  },
  async ({ browserId, action, index }: { browserId?: string; action: "list" | "new" | "close" | "select"; index?: number }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const instance = browserInstances.get(resolvedBrowserId);
      if (!instance) throw new Error(`Browser instance not found: ${resolvedBrowserId}`);

      const renderTabs = async (): Promise<string> => {
        const tabIds = [...instance.pages.keys()];
        if (!tabIds.length) return 'No open tabs. Use the "browser_navigate" tool to navigate to a page first.';
        return (
          await Promise.all(
            tabIds.map(async (id, tabIndex) => {
              const p = instance.pages.get(id);
              if (!p) return "";
              const current = id === instance.activePageId ? " (current)" : "";
              const t = await p.title().catch(() => "");
              const u = (() => {
                try {
                  return p.url();
                } catch {
                  return "";
                }
              })();
              return `- ${tabIndex}:${current} [${t}] (${u})`;
            })
          )
        )
          .filter(Boolean)
          .join("\n");
      };

      if (action === "new") {
        const page = await instance.context.newPage();
        registerPage(instance, page);
        return pwOk(`Created new tab.`, { tabs: await renderTabs() });
      }

      if (action === "select") {
        const tabIds = [...instance.pages.keys()];
        if (index === undefined) throw new Error("index is required for select action");
        const id = tabIds[index];
        if (!id) throw new Error(`Tab ${index} not found`);
        instance.activePageId = id;
        await instance.pages.get(id)?.bringToFront().catch(() => {});
        return pwOk(`Selected tab ${index}.`, { tabs: await renderTabs() });
      }

      if (action === "close") {
        const tabIds = [...instance.pages.keys()];
        const id = index === undefined ? instance.activePageId : tabIds[index];
        if (!id) throw new Error("No tab to close");
        const p = instance.pages.get(id);
        if (!p) throw new Error(`Tab not found: ${id}`);
        await p.close();
        return pwOk(`Closed tab.`, { tabs: await renderTabs() });
      }

      return pwOk(`Browser ID: ${resolvedBrowserId}`, { tabs: await renderTabs() });
    } catch (error) {
      return pwError("Failed to list tabs", error);
    }
  }
);

// Tool 1b: Navigate - Reuse an existing page and go to a new URL
server.tool(
  "navigate",
  "Navigate an existing page to a new URL (preserves login/session state)",
  {
    browserId: z.string().describe("Browser ID from a previous browse operation"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the first page in the browser)"),
    url: z.string().url().describe("The URL to navigate to"),
    waitFor: z.number().default(1000).describe("Time to wait after navigation (milliseconds)"),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("load").describe("Navigation wait condition")
  },
  async ({
    browserId,
    pageId,
    url,
    waitFor,
    waitUntil
  }: {
    browserId: string;
    pageId?: string;
    url: string;
    waitFor: number;
    waitUntil: "load" | "domcontentloaded" | "networkidle";
  }) => {
    try {
      const resolved = getPage(browserId, pageId);
      const page = resolved.page;

      const response = await page.goto(url, { waitUntil });
      await page.waitForTimeout(waitFor);

      const title = await page.title();
      const currentUrl = page.url();

      const screenshotPath = path.join(TEMP_DIR, `screenshot-${resolved.pageId}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });

      return pwOk(
        `Navigated to: ${url}\n\nCurrent URL: ${currentUrl}\nPage Title: ${title}\nStatus: ${
          response ? response.status() : "unknown"
        }\n\nBrowser ID: ${browserId}\nPage ID: ${resolved.pageId}\nScreenshot saved to: ${screenshotPath}`
      );
    } catch (error) {
      return pwError("Failed to navigate", error);
    }
  }
);

// Tool: browser_navigate - Navigate (create/reuse session similarly to browse)
server.tool(
  "browser_navigate",
  "Navigate to a URL (creates/reuses a persistent profile by default)",
  {
    url: z.string().url().describe("The URL to navigate to"),
    headless: z.boolean().default(false).describe("Whether to run the browser in headless mode"),
    waitFor: z.number().default(1000).describe("Time to wait after navigation (milliseconds)"),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("load").describe("Navigation wait condition"),
    profile: z
      .string()
      .default("default")
      .describe("Persistent profile name (reused across calls and restarts; pass different names for multi-account isolation)"),
    isolated: z.boolean().default(false).describe("Start a temporary isolated session (ignores profile; does not persist)"),
    browserId: z
      .string()
      .optional()
      .describe("Reuse an existing browserId instead of profile/isolated (supports browserId starting with profile:)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    newPage: z.boolean().default(false).describe("Open a new tab/page instead of reusing the active page")
  },
  async ({
    url,
    headless,
    waitFor,
    waitUntil,
    profile,
    isolated,
    browserId,
    pageId,
    newPage
  }: {
    url: string;
    headless: boolean;
    waitFor: number;
    waitUntil: "load" | "domcontentloaded" | "networkidle";
    profile: string;
    isolated: boolean;
    browserId?: string;
    pageId?: string;
    newPage: boolean;
  }) => {
    try {
      const launchArgs = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu"
      ];

      const session = await getOrCreateSession({
        browserId,
        profile,
        isolated,
        headless,
        launchArgs
      });

      const resolvedBrowserId = session.browserId;
      const instance = session.instance;

      let resolvedPageId: string;
      let page: Page;
      if (newPage) {
        page = await instance.context.newPage();
        resolvedPageId = registerPage(instance, page);
      } else {
        const resolved = getPage(resolvedBrowserId, pageId);
        resolvedPageId = resolved.pageId;
        page = resolved.page;
      }

      const response = await page.goto(url, { waitUntil });
      await page.waitForTimeout(waitFor);

      const title = await page.title().catch(() => "");
      const currentUrl = page.url();
      const screenshotPath = path.join(TEMP_DIR, `screenshot-${resolvedPageId}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });

      return pwOk(
        `Navigated to: ${url}\n\nCurrent URL: ${currentUrl}\nPage Title: ${title}\nStatus: ${
          response ? response.status() : "unknown"
        }\n\nBrowser ID: ${resolvedBrowserId}\nPage ID: ${resolvedPageId}\nPersistent Profile: ${
          instance.isPersistent ? instance.profile : "no"
        }\nReused Session: ${session.wasReused}\nScreenshot saved to: ${screenshotPath}`
      );
    } catch (error) {
      return pwError("Failed to navigate", error);
    }
  }
);

// Tool 1b-alt: browser_navigate_back - Go back in history
server.tool(
  "browser_navigate_back",
  "Navigate back in the current tab's history",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    waitFor: z.number().default(1000).describe("Time to wait after navigation (milliseconds)"),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("load").describe("Navigation wait condition")
  },
  async ({
    browserId,
    pageId,
    waitFor,
    waitUntil
  }: {
    browserId?: string;
    pageId?: string;
    waitFor: number;
    waitUntil: "load" | "domcontentloaded" | "networkidle";
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      const response = await page.goBack({ waitUntil });
      await page.waitForTimeout(waitFor);

      const screenshotPath = path.join(TEMP_DIR, `screenshot-${resolved.pageId}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });

      return pwOk(
        `Navigated back.\n\nBrowser ID: ${resolvedBrowserId}\nPage ID: ${resolved.pageId}\nCurrent URL: ${page.url()}\nStatus: ${
          response ? response.status() : "no-entry"
        }\nScreenshot saved to: ${screenshotPath}`
      );
    } catch (error) {
      return pwError("Failed to navigate back", error);
    }
  }
);

// Tool: browser_wait_for - Wait for selector/url/load state/timeout
server.tool(
  "browser_wait_for",
  "Wait for a selector, URL, load state, or a timeout",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    time: z.number().optional().describe("Playwright-style: time to wait in seconds"),
    text: z.string().optional().describe("Playwright-style: text to wait for to appear"),
    textGone: z.string().optional().describe("Playwright-style: text to wait for to disappear"),
    mode: z
      .enum(["timeout", "selector", "url", "load_state"])
      .default("timeout")
      .describe("Wait mode"),
    timeoutMs: z.number().default(30000).describe("Timeout for selector/url/load_state modes (milliseconds)"),
    durationMs: z.number().default(1000).describe("Duration for timeout mode (milliseconds)"),
    selector: z.string().optional().describe("CSS selector to wait for (selector mode)"),
    state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible").describe("Selector state"),
    url: z.string().optional().describe("Exact URL to wait for (url mode)"),
    urlContains: z.string().optional().describe("URL substring to wait for (url mode)"),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("load").describe("URL wait condition"),
    loadState: z.enum(["load", "domcontentloaded", "networkidle"]).default("load").describe("Load state (load_state mode)")
  },
  async ({
    browserId,
    pageId,
    time,
    text,
    textGone,
    mode,
    timeoutMs,
    durationMs,
    selector,
    state,
    url,
    urlContains,
    waitUntil,
    loadState
  }: {
    browserId?: string;
    pageId?: string;
    time?: number;
    text?: string;
    textGone?: string;
    mode: "timeout" | "selector" | "url" | "load_state";
    timeoutMs: number;
    durationMs: number;
    selector?: string;
    state: "attached" | "detached" | "visible" | "hidden";
    url?: string;
    urlContains?: string;
    waitUntil: "load" | "domcontentloaded" | "networkidle";
    loadState: "load" | "domcontentloaded" | "networkidle";
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      const codeLines: string[] = [];
      if (time !== undefined || text || textGone) {
        if (time !== undefined) {
          codeLines.push(`await new Promise(f => setTimeout(f, ${time} * 1000));`);
          await page.waitForTimeout(Math.min(30_000, Math.max(0, time) * 1000));
        }
        if (textGone) {
          codeLines.push(`await page.getByText(${JSON.stringify(textGone)}).first().waitFor({ state: 'hidden' });`);
          await page.getByText(textGone).first().waitFor({ state: "hidden", timeout: timeoutMs });
        }
        if (text) {
          codeLines.push(`await page.getByText(${JSON.stringify(text)}).first().waitFor({ state: 'visible' });`);
          await page.getByText(text).first().waitFor({ state: "visible", timeout: timeoutMs });
        }

        return pwOk(`Wait completed.`, {
          code: codeLines.join("\n"),
          page: { url: page.url(), title: await page.title().catch(() => "") }
        });
      }

      switch (mode) {
        case "timeout":
          await page.waitForTimeout(durationMs);
          break;
        case "selector":
          if (!selector) throw new Error("selector is required for selector mode");
          await page.waitForSelector(selector, { state, timeout: timeoutMs });
          break;
        case "url":
          if (url) {
            await page.waitForURL(url, { timeout: timeoutMs, waitUntil });
          } else if (urlContains) {
            await page.waitForURL((u) => u.toString().includes(urlContains), { timeout: timeoutMs, waitUntil });
          } else {
            throw new Error("url or urlContains is required for url mode");
          }
          break;
        case "load_state":
          await page.waitForLoadState(loadState, { timeout: timeoutMs });
          break;
      }

      return pwOk(`Wait completed.`, { page: { url: page.url(), title: await page.title().catch(() => "") } });
    } catch (error) {
      return pwError("Failed to wait", error);
    }
  }
);

server.tool(
  "browser_handle_dialog",
  "Handle the next JavaScript dialog (alert/confirm/prompt)",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    action: z.enum(["accept", "dismiss"]).default("dismiss").describe("How to handle the dialog"),
    promptText: z.string().optional().describe("Prompt text for prompt dialogs (accept only)"),
    timeoutMs: z.number().default(30000).describe("Timeout waiting for a dialog (milliseconds)")
  },
  async ({
    browserId,
    pageId,
    action,
    promptText,
    timeoutMs
  }: {
    browserId?: string;
    pageId?: string;
    action: "accept" | "dismiss";
    promptText?: string;
    timeoutMs: number;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      const dialog = await page.waitForEvent("dialog", { timeout: timeoutMs });
      const message = dialog.message();
      const type = dialog.type();
      const defaultValue = dialog.defaultValue();

      if (action === "accept") await dialog.accept(promptText);
      else await dialog.dismiss();

      return pwOk(
        `Dialog handled.\n\nBrowser ID: ${resolvedBrowserId}\nPage ID: ${resolved.pageId}\nType: ${type}\nMessage: ${message}\nDefault Value: ${defaultValue}\nAction: ${action}`
      );
    } catch (error) {
      return pwError("Failed to handle dialog", error);
    }
  }
);

server.tool(
  "browser_resize",
  "Resize the page viewport",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    width: z.number().int().min(1).describe("Viewport width"),
    height: z.number().int().min(1).describe("Viewport height")
  },
  async ({
    browserId,
    pageId,
    width,
    height
  }: {
    browserId?: string;
    pageId?: string;
    width: number;
    height: number;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const { pageId: resolvedPageId, page } = getPage(resolvedBrowserId, pageId);
      await page.setViewportSize({ width, height });

      return pwOk(
        `Viewport resized.\n\nBrowser ID: ${resolvedBrowserId}\nPage ID: ${resolvedPageId}\nSize: ${width}x${height}\nCurrent URL: ${page.url()}`
      );
    } catch (error) {
      return pwError("Failed to resize viewport", error);
    }
  }
);

server.tool(
  "browser_press_key",
  "Press a keyboard key in the page (optionally focusing an element first)",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    key: z.string().describe("Key to press (e.g. Enter, Escape, ArrowDown, Control+A)"),
    selector: z.string().optional().describe("Optional selector to focus before pressing the key"),
    delayMs: z.number().optional().describe("Delay between keydown and keyup (milliseconds)")
  },
  async ({
    browserId,
    pageId,
    key,
    selector,
    delayMs
  }: {
    browserId?: string;
    pageId?: string;
    key: string;
    selector?: string;
    delayMs?: number;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      if (selector) await page.focus(selector);
      await page.keyboard.press(key, delayMs === undefined ? undefined : { delay: delayMs });

      return pwOk(`Key pressed.\n\nBrowser ID: ${resolvedBrowserId}\nPage ID: ${resolved.pageId}\nKey: ${key}\nCurrent URL: ${page.url()}`);
    } catch (error) {
      return pwError("Failed to press key", error);
    }
  }
);

server.tool(
  "browser_type",
  "Type text into an editable element (Playwright ref-first; selector fallback supported)",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    target: actionTargetSchema
      .optional()
      .describe("Preferred. Either {kind:'ref', element, ref} from snapshot or {kind:'selector', selector} fallback."),
    element: z
      .string()
      .optional()
      .describe("Human-readable element description used to obtain permission to interact with the element"),
    ref: z.string().optional().describe("Exact target element reference from the page snapshot"),
    selector: z.string().optional().describe("Fallback selector (legacy)"),
    text: z.string().describe("Text to type into the element"),
    submit: z.boolean().optional().describe("Whether to submit entered text (press Enter after)"),
    delayMs: z.number().optional().describe("Legacy: delay between key presses for keyboard typing (milliseconds)"),
    slowly: z
      .boolean()
      .optional()
      .describe("Whether to type one character at a time. Useful for triggering key handlers in the page.")
  },
  async ({
    browserId,
    pageId,
    target,
    element,
    ref,
    selector,
    text,
    submit,
    delayMs,
    slowly
  }: {
    browserId?: string;
    pageId?: string;
    target?: ActionTarget;
    element?: string;
    ref?: string;
    text: string;
    selector?: string;
    submit?: boolean;
    delayMs?: number;
    slowly?: boolean;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      const resolvedTarget = await resolveActionLocator(page, { target, element, ref, selector }, { required: false });
      if (resolvedTarget) {
        const codeLines: string[] = [];
        if (slowly) {
          codeLines.push(`await page.${resolvedTarget.resolved}.pressSequentially(${JSON.stringify(text)});`);
          await (resolvedTarget.locator as any).pressSequentially(text);
        } else {
          codeLines.push(`await page.${resolvedTarget.resolved}.fill(${JSON.stringify(text)});`);
          await resolvedTarget.locator.fill(text);
        }
        if (submit) {
          codeLines.push(`await page.${resolvedTarget.resolved}.press('Enter');`);
          await resolvedTarget.locator.press("Enter");
        }

        return pwOk(`Typed text.`, { code: codeLines.join("\n"), page: { url: page.url(), title: await page.title().catch(() => "") } });
      }

      // Legacy behavior: type into currently focused element.
      await page.keyboard.type(text, delayMs === undefined ? undefined : { delay: delayMs });
      if (submit) await page.keyboard.press("Enter");
      return pwOk(`Typed text (keyboard).`, { page: { url: page.url(), title: await page.title().catch(() => "") } });
    } catch (error) {
      return pwError("Failed to type", error);
    }
  }
);

server.tool(
  "browser_press_sequentially",
  "Press text sequentially on the keyboard",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    text: z.string().describe("Text to press sequentially"),
    submit: z.boolean().optional().describe("Whether to submit entered text (press Enter after)")
  },
  async ({
    browserId,
    pageId,
    text,
    submit
  }: {
    browserId?: string;
    pageId?: string;
    text: string;
    submit?: boolean;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      await page.keyboard.type(text);
      if (submit) await page.keyboard.press("Enter");

      return pwOk(
        `Pressed sequentially.\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolved.pageId}\\nLength: ${text.length}\\nSubmitted: ${Boolean(
          submit
        )}\\nCurrent URL: ${page.url()}`
      );
    } catch (error) {
      return pwError("Failed to press sequentially", error);
    }
  }
);

server.tool(
  "browser_hover",
  "Hover over an element",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    target: actionTargetSchema
      .optional()
      .describe("Preferred. Either {kind:'ref', element, ref} from snapshot or {kind:'selector', selector} fallback."),
    element: z
      .string()
      .optional()
      .describe("Human-readable element description used to obtain permission to interact with the element"),
    ref: z.string().optional().describe("Exact target element reference from the page snapshot"),
    selector: z.string().optional().describe("Fallback selector (legacy)")
  },
  async ({
    browserId,
    pageId,
    target,
    element,
    ref,
    selector
  }: {
    browserId?: string;
    pageId?: string;
    target?: ActionTarget;
    element?: string;
    ref?: string;
    selector?: string;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const { pageId: resolvedPageId, page } = getPage(resolvedBrowserId, pageId);

      const resolvedTarget = (await resolveActionLocator(page, { target, element, ref, selector }))!;
      await resolvedTarget.locator.hover();
      return pwOk(`Hovered.`, {
        code: `await page.${resolvedTarget.resolved}.hover();`,
        page: { url: page.url(), title: await page.title().catch(() => "") }
      });
    } catch (error) {
      return pwError("Failed to hover", error);
    }
  }
);

server.tool(
  "browser_drag",
  "Drag and drop from one selector to another",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    startElement: z.string().optional().describe("Human-readable source element description"),
    startRef: z.string().optional().describe("Exact source element reference from the page snapshot"),
    endElement: z.string().optional().describe("Human-readable target element description"),
    endRef: z.string().optional().describe("Exact target element reference from the page snapshot"),
    source: z.string().optional().describe("Fallback source selector (legacy)"),
    target: z.string().optional().describe("Fallback target selector (legacy)")
  },
  async ({
    browserId,
    pageId,
    startElement,
    startRef,
    endElement,
    endRef,
    source,
    target
  }: {
    browserId?: string;
    pageId?: string;
    startElement?: string;
    startRef?: string;
    endElement?: string;
    endRef?: string;
    source?: string;
    target?: string;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const { pageId: resolvedPageId, page } = getPage(resolvedBrowserId, pageId);

      const usingRef = Boolean(startElement && startRef && endElement && endRef);
      const usingSelector = Boolean(source && target);
      if (!usingRef && !usingSelector) {
        throw new Error("Either startElement+startRef+endElement+endRef or source+target must be provided.");
      }
      if (!pwUtils) pwUtils = require("patchright-core/lib/utils");

      const start = usingRef
        ? await refLocator(page, { element: startElement!, ref: startRef! })
        : { locator: page.locator(source!), resolved: pwUtils.asLocator("javascript", source!) };
      const end = usingRef
        ? await refLocator(page, { element: endElement!, ref: endRef! })
        : { locator: page.locator(target!), resolved: pwUtils.asLocator("javascript", target!) };

      await start.locator.dragTo(end.locator);

      return pwOk(`Drag completed.`, {
        code: `await page.${start.resolved}.dragTo(page.${end.resolved});`,
        page: { url: page.url(), title: await page.title().catch(() => "") }
      });
    } catch (error) {
      return pwError("Failed to drag", error);
    }
  }
);

server.tool(
  "browser_click",
  "Click an element",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    target: actionTargetSchema
      .optional()
      .describe("Preferred. Either {kind:'ref', element, ref} from snapshot or {kind:'selector', selector} fallback."),
    element: z
      .string()
      .optional()
      .describe("Human-readable element description used to obtain permission to interact with the element"),
    ref: z.string().optional().describe("Exact target element reference from the page snapshot"),
    selector: z.string().optional().describe("Fallback selector (legacy)"),
    doubleClick: z.boolean().optional().describe("Whether to perform a double click instead of a single click"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Button to click, defaults to left"),
    modifiers: z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe("Modifier keys to press")
  },
  async ({
    browserId,
    pageId,
    target,
    element,
    ref,
    selector,
    doubleClick,
    button,
    modifiers
  }: {
    browserId?: string;
    pageId?: string;
    target?: ActionTarget;
    element?: string;
    ref?: string;
    selector?: string;
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const { pageId: resolvedPageId, page } = getPage(resolvedBrowserId, pageId);

      const resolvedTarget = (await resolveActionLocator(page, { target, element, ref, selector }))!;

      const options: Record<string, unknown> = {};
      if (button) options.button = button;
      if (modifiers?.length) options.modifiers = modifiers;
      const optionsText = Object.keys(options).length ? JSON.stringify(options) : "";

      if (doubleClick) await resolvedTarget.locator.dblclick(options as any);
      else await resolvedTarget.locator.click(options as any);

      const method = doubleClick ? "dblclick" : "click";
      const code = `await page.${resolvedTarget.resolved}.${method}(${optionsText});`.replace(/\(\);$/, "();");

      return pwOk(`Clicked.`, { code, page: { url: page.url(), title: await page.title().catch(() => "") } });
    } catch (error) {
      return pwError("Failed to click", error);
    }
  }
);

server.tool(
  "browser_select_option",
  "Select an option in a <select> element",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    target: actionTargetSchema
      .optional()
      .describe("Preferred. Either {kind:'ref', element, ref} from snapshot or {kind:'selector', selector} fallback."),
    element: z
      .string()
      .optional()
      .describe("Human-readable element description used to obtain permission to interact with the element"),
    ref: z.string().optional().describe("Exact target element reference from the page snapshot"),
    selector: z.string().optional().describe("Fallback selector (legacy)"),
    values: z.array(z.string()).optional().describe("Array of values to select"),
    value: z.union([z.string(), z.array(z.string())]).optional().describe("Legacy value(s) to select")
  },
  async ({
    browserId,
    pageId,
    target,
    element,
    ref,
    selector,
    values,
    value
  }: {
    browserId?: string;
    pageId?: string;
    target?: ActionTarget;
    element?: string;
    ref?: string;
    selector?: string;
    values?: string[];
    value?: string | string[];
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const { pageId: resolvedPageId, page } = getPage(resolvedBrowserId, pageId);

      const selectedValues: string[] = values ?? (Array.isArray(value) ? value : value ? [value] : []);
      if (!selectedValues.length) throw new Error("values/value is required");

      const resolvedTarget = (await resolveActionLocator(page, { target, element, ref, selector }))!;
      await resolvedTarget.locator.selectOption(selectedValues);

      return pwOk(`Selected option.`, {
        code: `await page.${resolvedTarget.resolved}.selectOption(${JSON.stringify(selectedValues)});`,
        page: { url: page.url(), title: await page.title().catch(() => "") }
      });
    } catch (error) {
      return pwError("Failed to select option", error);
    }
  }
);

server.tool(
  "browser_fill_form",
  "Fill multiple form fields",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    fields: z
      .array(
        z.object({
          selector: z.string(),
          value: z.string()
        })
      )
      .min(1)
      .describe("Fields to fill: [{ selector, value }, ...]"),
    submitSelector: z.string().optional().describe("Optional selector to click after filling the form"),
    waitFor: z.number().default(500).describe("Time to wait after filling/clicking (milliseconds)")
  },
  async ({
    browserId,
    pageId,
    fields,
    submitSelector,
    waitFor
  }: {
    browserId?: string;
    pageId?: string;
    fields: Array<{ selector: string; value: string }>;
    submitSelector?: string;
    waitFor: number;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const { pageId: resolvedPageId, page } = getPage(resolvedBrowserId, pageId);

      for (const field of fields) {
        await page.fill(field.selector, field.value);
      }

      if (submitSelector) {
        await page.click(submitSelector);
      }

      if (waitFor > 0) await page.waitForTimeout(waitFor);

      return pwOk(
        `Form filled.\n\nBrowser ID: ${resolvedBrowserId}\nPage ID: ${resolvedPageId}\nFields: ${fields.length}\nCurrent URL: ${page.url()}`
      );
    } catch (error) {
      return pwError("Failed to fill form", error);
    }
  }
);

server.tool(
  "browser_file_upload",
  "Upload files by setting input[type=file] files",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    selector: z.string().describe("File input selector"),
    paths: z.array(z.string()).describe("File paths to upload")
  },
  async ({
    browserId,
    pageId,
    selector,
    paths
  }: {
    browserId?: string;
    pageId?: string;
    selector: string;
    paths: string[];
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const { pageId: resolvedPageId, page } = getPage(resolvedBrowserId, pageId);
      await page.setInputFiles(selector, paths);

      return pwOk(
        `Files uploaded.\n\nBrowser ID: ${resolvedBrowserId}\nPage ID: ${resolvedPageId}\nSelector: ${selector}\nCount: ${paths.length}\nCurrent URL: ${page.url()}`
      );
    } catch (error) {
      return pwError("Failed to upload files", error);
    }
  }
);

server.tool(
  "browser_console_messages",
  "Get new console messages for the current page",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    limit: z.number().default(50).describe("Max messages to return"),
    clear: z.boolean().default(true).describe("Clear buffered messages after returning them")
  },
  async ({
    browserId,
    pageId,
    limit,
    clear
  }: {
    browserId?: string;
    pageId?: string;
    limit: number;
    clear: boolean;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const buffer = resolved.instance.consoleMessages.get(resolved.pageId) ?? [];
      const items = buffer.slice(Math.max(0, buffer.length - limit));
      if (clear) buffer.length = 0;

      return pwOk(items.length ? items.join("\n") : "No new console messages.");
    } catch (error) {
      return pwError("Failed to get console messages", error);
    }
  }
);

server.tool(
  "browser_network_requests",
  "Get recent network request/response events for the current page",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    limit: z.number().default(100).describe("Max events to return"),
    clear: z.boolean().default(true).describe("Clear buffered events after returning them"),
    include: z.enum(["requests", "responses", "both"]).default("both").describe("Which events to include"),
    urlContains: z.string().optional().describe("Only include events whose URL contains this substring")
  },
  async ({
    browserId,
    pageId,
    limit,
    clear,
    include,
    urlContains
  }: {
    browserId?: string;
    pageId?: string;
    limit: number;
    clear: boolean;
    include: "requests" | "responses" | "both";
    urlContains?: string;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const buffer = resolved.instance.networkEvents.get(resolved.pageId) ?? [];
      const filtered = buffer.filter((e) => {
        if (urlContains && !e.url.includes(urlContains)) return false;
        if (include === "both") return true;
        return e.type === include.slice(0, -1);
      });
      const items = filtered.slice(Math.max(0, filtered.length - limit));
      if (clear) buffer.length = 0;

      const lines = items.map((e) => {
        if (e.type === "request") return `REQ ${e.method ?? ""} ${e.resourceType ?? ""} ${e.url}`.trim();
        return `RES ${e.status ?? ""} ${e.url}`.trim();
      });

      return pwOk(lines.length ? lines.join("\n") : "No network events.");
    } catch (error) {
      return pwError("Failed to get network events", error);
    }
  }
);

server.tool(
  "browser_snapshot",
  "Get a snapshot of the current page (aria/text/html)",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    type: z.enum(["aria", "text", "html"]).default("aria").describe("Snapshot type"),
    maxNodes: z.number().default(200).describe("Max nodes for aria snapshot"),
    maxChars: z.number().default(8000).describe("Max characters for text/html snapshot")
  },
  async ({
    browserId,
    pageId,
    type,
    maxNodes,
    maxChars
  }: {
    browserId?: string;
    pageId?: string;
    type: "aria" | "text" | "html";
    maxNodes: number;
    maxChars: number;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      const title = await page.title().catch(() => "");
      const url = page.url();

      let body = "";
      let snapshotLanguage: "yaml" | "text" | "html" = type === "html" ? "html" : type === "text" ? "text" : "yaml";
      let note: string | undefined;
      if (type === "aria") {
        try {
          const snapshot = await snapshotForAI(page);
          body = snapshot.full;
        } catch (e) {
          body = await ariaSnapshotFallback(page, maxNodes);
          snapshotLanguage = "text";
          note = `ARIA snapshot fallback used (no refs). ${stringifyError(e)}`;
        }
      } else if (type === "html") {
        body = await page.content();
      } else {
        body = (await page.evaluate(`
          Array.from(document.querySelectorAll('body, body *'))
            .filter(element => {
              const style = window.getComputedStyle(element);
              return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            })
            .map(element => element.textContent)
            .filter(text => text && text.trim().length > 0)
            .join('\\n')
        `)) as string;
      }

      if (type !== "aria" && body.length > maxChars) body = body.slice(0, maxChars) + `\n... (truncated, maxChars=${maxChars})`;

      const instance = resolved.instance;

      const tabIds = [...instance.pages.keys()];
      const tabs =
        tabIds.length > 1
          ? (
              await Promise.all(
                tabIds.map(async (id, index) => {
                  const p = instance.pages.get(id);
                  if (!p) return "";
                  const current = id === instance.activePageId ? " (current)" : "";
                  const t = await p.title().catch(() => "");
                  const u = (() => {
                    try {
                      return p.url();
                    } catch {
                      return "";
                    }
                  })();
                  return `- ${index}:${current} [${t}] (${u})`;
                })
              )
            )
              .filter(Boolean)
              .join("\n")
          : undefined;

      const recent = instance.recentConsoleMessages.get(resolved.pageId) ?? [];
      const consoleMessages = recent.length ? recent.map((m) => `- ${trimText(m, 100)}`).join("\n") : undefined;
      recent.length = 0;

      const downloadsList = instance.downloads.get(resolved.pageId) ?? [];
      const downloads = downloadsList.length
        ? downloadsList
            .map((d) => (d.finished ? `- Downloaded file ${d.suggestedFilename} to ${d.outputFile}` : `- Downloading file ${d.suggestedFilename} ...`))
            .join("\n")
        : undefined;

      return pwRespond({
        ...(note ? { result: note } : {}),
        tabs,
        consoleMessages,
        downloads,
        page: { url, title },
        snapshot: { text: body, language: snapshotLanguage }
      });
    } catch (error) {
      return pwError("Failed to snapshot", error);
    }
  }
);

server.tool(
  "browser_generate_locator",
  "Generate a Playwright locator expression for an element (best-effort)",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    element: z
      .string()
      .describe("Human-readable element description used to obtain permission to interact with the element"),
    ref: z.string().describe("Exact target element reference from the page snapshot")
  },
  async ({
    browserId,
    pageId,
    element,
    ref
  }: {
    browserId?: string;
    pageId?: string;
    element: string;
    ref: string;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      const target = await refLocator(page, { element, ref });
      return pwOk(target.resolved);
    } catch (error) {
      return pwError("Failed to generate locator", error);
    }
  }
);

server.tool(
  "browser_take_screenshot",
  "Take a screenshot of the current page",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    type: z.enum(["png", "jpeg"]).default("png").describe("Image format for the screenshot. Default is png."),
    filename: z
      .string()
      .optional()
      .describe("File name to save the screenshot to. Defaults to `page-{timestamp}.{png|jpeg}` if not specified."),
    element: z
      .string()
      .optional()
      .describe("Human-readable element description used to obtain permission to screenshot the element. If provided, ref must be provided too."),
    ref: z.string().optional().describe("Exact target element reference from the page snapshot. If provided, element must be provided too."),
    fullPage: z.boolean().optional().describe("When true, takes a screenshot of the full scrollable page. Cannot be used with element screenshots.")
  },
  async ({
    browserId,
    pageId,
    type,
    filename,
    element,
    ref,
    fullPage
  }: {
    browserId?: string;
    pageId?: string;
    type: "png" | "jpeg";
    filename?: string;
    element?: string;
    ref?: string;
    fullPage?: boolean;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const { pageId: resolvedPageId, page } = getPage(resolvedBrowserId, pageId);

      if (!!element !== !!ref) throw new Error("Both element and ref must be provided or neither.");
      if (fullPage && ref) throw new Error("fullPage cannot be used with element screenshots.");

      const fileType = type || "png";
      const outName = sanitizeFileName(filename ?? "", `page-${Date.now()}`, fileType);
      const screenshotPath = path.join(TEMP_DIR, outName);

      const options: any = {
        type: fileType,
        quality: fileType === "png" ? undefined : 90,
        scale: "css",
        ...(fullPage !== undefined ? { fullPage } : {})
      };

      const isElementScreenshot = Boolean(element && ref);
      const screenshotTarget = isElementScreenshot ? element! : fullPage ? "full page" : "viewport";

      let buffer: Buffer;
      let code = "";
      if (isElementScreenshot) {
        const target = await refLocator(page, { element: element!, ref: ref! });
        code = `await page.${target.resolved}.screenshot(${JSON.stringify(options)});`;
        buffer = (await target.locator.screenshot(options)) as Buffer;
      } else {
        code = `await page.screenshot(${JSON.stringify(options)});`;
        buffer = (await page.screenshot(options)) as Buffer;
      }

      await fs.writeFile(screenshotPath, buffer);

      const images = [
        {
          mimeType: fileType === "png" ? "image/png" : "image/jpeg",
          data: scaleImageToFitMessage(buffer, fileType)
        }
      ];

      return pwOk(`Took the ${screenshotTarget} screenshot and saved it as ${screenshotPath}`, {
        code,
        page: { url: page.url(), title: await page.title().catch(() => "") },
        images
      });
    } catch (error) {
      return pwError("Failed to take screenshot", error);
    }
  }
);

server.tool(
  "browser_pdf_save",
  "Save page as PDF",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    filename: z
      .string()
      .optional()
      .describe("File name to save the pdf to. Defaults to `page-{timestamp}.pdf` if not specified.")
  },
  async ({ browserId, pageId, filename }: { browserId?: string; pageId?: string; filename?: string }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      await ensureDir(PDFS_DIR);
      const outName = sanitizeFileName(filename ?? "", `page-${Date.now()}`, "pdf");
      const outPath = path.join(PDFS_DIR, outName);

      await page.pdf({ path: outPath });

      return pwOk(`Saved page as PDF.\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolved.pageId}\\nPath: ${outPath}`);
    } catch (error) {
      return pwError("Failed to save PDF", error);
    }
  }
);

server.tool(
  "browser_evaluate",
  "Evaluate JavaScript in the page context and return the result (use `return` to return a value; `await` is allowed)",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    expression: z.string().describe("JavaScript snippet (function body). Example: `return localStorage.getItem('accessToken')`")
  },
  async ({
    browserId,
    pageId,
    expression
  }: {
    browserId?: string;
    pageId?: string;
    expression: string;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      const wrapped = `(async () => { ${expression}\n})()`;
      const result = (await page.evaluate(wrapped)) as unknown;

      return pwOk(
        `Evaluation completed.\n\nBrowser ID: ${resolvedBrowserId}\nPage ID: ${resolved.pageId}\nCurrent URL: ${page.url()}\n\nResult:\n${formatEvalResult(
          result
        )}`
      );
    } catch (error) {
      return pwError("Failed to evaluate", error);
    }
  }
);

server.tool(
  "browser_mouse_move_xy",
  "Move mouse to a given position",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    element: z
      .string()
      .describe("Human-readable element description used to obtain permission to interact with the element"),
    x: z.number().describe("X coordinate"),
    y: z.number().describe("Y coordinate")
  },
  async ({ browserId, pageId, x, y }: { browserId?: string; pageId?: string; element: string; x: number; y: number }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      await page.mouse.move(x, y);

      return pwOk(
        `Mouse moved.\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolved.pageId}\\nPosition: (${x}, ${y})\\nCurrent URL: ${page.url()}`
      );
    } catch (error) {
      return pwError("Failed to move mouse", error);
    }
  }
);

server.tool(
  "browser_mouse_click_xy",
  "Click left mouse button at a given position",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    element: z
      .string()
      .describe("Human-readable element description used to obtain permission to interact with the element"),
    x: z.number().describe("X coordinate"),
    y: z.number().describe("Y coordinate")
  },
  async ({ browserId, pageId, x, y }: { browserId?: string; pageId?: string; element: string; x: number; y: number }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();

      return pwOk(
        `Mouse clicked.\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolved.pageId}\\nPosition: (${x}, ${y})\\nCurrent URL: ${page.url()}`
      );
    } catch (error) {
      return pwError("Failed to click mouse", error);
    }
  }
);

server.tool(
  "browser_mouse_drag_xy",
  "Drag left mouse button to a given position",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    element: z
      .string()
      .describe("Human-readable element description used to obtain permission to interact with the element"),
    startX: z.number().describe("Start X coordinate"),
    startY: z.number().describe("Start Y coordinate"),
    endX: z.number().describe("End X coordinate"),
    endY: z.number().describe("End Y coordinate")
  },
  async ({
    browserId,
    pageId,
    startX,
    startY,
    endX,
    endY
  }: {
    browserId?: string;
    pageId?: string;
    element: string;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY);
      await page.mouse.up();

      return pwOk(
        `Mouse dragged.\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolved.pageId}\\nFrom: (${startX}, ${startY})\\nTo: (${endX}, ${endY})\\nCurrent URL: ${page.url()}`
      );
    } catch (error) {
      return pwError("Failed to drag mouse", error);
    }
  }
);

server.tool(
  "browser_start_tracing",
  "Start trace recording",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)")
  },
  async ({ browserId }: { browserId?: string }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const instance = browserInstances.get(resolvedBrowserId);
      if (!instance) throw new Error(`Browser instance not found: ${resolvedBrowserId}`);
      if (tracingSessions.has(resolvedBrowserId)) throw new Error("Tracing already started for this browserId");

      await ensureDir(TRACES_DIR);
      await instance.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const zipPath = path.join(TRACES_DIR, `trace-${Date.now()}-${randomUUID().slice(0, 8)}.zip`);
      tracingSessions.set(resolvedBrowserId, { zipPath, startedAt: Date.now() });

      return pwOk(`Tracing started.\\n\\nBrowser ID: ${resolvedBrowserId}\\nOutput (on stop): ${zipPath}`);
    } catch (error) {
      return pwError("Failed to start tracing", error);
    }
  }
);

server.tool(
  "browser_stop_tracing",
  "Stop trace recording",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)")
  },
  async ({ browserId }: { browserId?: string }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const instance = browserInstances.get(resolvedBrowserId);
      if (!instance) throw new Error(`Browser instance not found: ${resolvedBrowserId}`);

      const state = tracingSessions.get(resolvedBrowserId);
      if (!state) throw new Error("Tracing is not started for this browserId");

      try {
        await ensureDir(TRACES_DIR);
        await instance.context.tracing.stop({ path: state.zipPath });
      } finally {
        tracingSessions.delete(resolvedBrowserId);
      }

      return pwOk(`Tracing stopped.\\n\\nBrowser ID: ${resolvedBrowserId}\\nTrace saved to: ${state.zipPath}`);
    } catch (error) {
      return pwError("Failed to stop tracing", error);
    }
  }
);

server.tool(
  "browser_verify_element_visible",
  "Verify element is visible on the page",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    role: z.string().describe('ROLE of the element (e.g. \"button\")'),
    accessibleName: z.string().describe('Accessible name of the element (e.g. \"Submit\")'),
    timeoutMs: z.number().default(5000).describe("Timeout (milliseconds)")
  },
  async ({
    browserId,
    pageId,
    role,
    accessibleName,
    timeoutMs
  }: {
    browserId?: string;
    pageId?: string;
    role: string;
    accessibleName: string;
    timeoutMs: number;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      const locator = page.getByRole(role as never, { name: accessibleName });
      const count = await locator.count();
      if (!count) throw new Error(`Element not found: role=\"${role}\" name=\"${accessibleName}\"`);

      const ok = await locator.first().waitFor({ state: "visible", timeout: timeoutMs }).then(() => true, () => false);
      if (!ok) throw new Error(`Element not visible: role=\"${role}\" name=\"${accessibleName}\"`);

      return pwOk(
        `Verified element visible.\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolved.pageId}\\nrole=\"${role}\" name=\"${accessibleName}\"`
      );
    } catch (error) {
      return pwError("Verify failed", error);
    }
  }
);

server.tool(
  "browser_verify_text_visible",
  "Verify text is visible on the page",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    text: z.string().describe("Text to verify"),
    timeoutMs: z.number().default(5000).describe("Timeout (milliseconds)")
  },
  async ({
    browserId,
    pageId,
    text,
    timeoutMs
  }: {
    browserId?: string;
    pageId?: string;
    text: string;
    timeoutMs: number;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      const locator = page.getByText(text).first();
      const ok = await locator.waitFor({ state: "visible", timeout: timeoutMs }).then(() => true, () => false);
      if (!ok) throw new Error(`Text not visible: ${text}`);

      return pwOk(`Verified text visible.\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolved.pageId}\\nText: ${text}`);
    } catch (error) {
      return pwError("Verify failed", error);
    }
  }
);

server.tool(
  "browser_verify_list_visible",
  "Verify list items are visible on the page (best-effort; `ref` treated as locator selector)",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    element: z.string().describe("Human-readable list description"),
    ref: z.string().describe("Target element reference; treated as a Playwright locator selector in this server"),
    items: z.array(z.string()).describe("Items to verify"),
    timeoutMs: z.number().default(5000).describe("Timeout (milliseconds)")
  },
  async ({
    browserId,
    pageId,
    element,
    ref,
    items,
    timeoutMs
  }: {
    browserId?: string;
    pageId?: string;
    element: string;
    ref: string;
    items: string[];
    timeoutMs: number;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;
      const selector = ref?.trim();
      if (!selector) throw new Error("ref is required");

      const listLocator = page.locator(selector).first();
      const ok = await listLocator.waitFor({ state: "visible", timeout: timeoutMs }).then(() => true, () => false);
      if (!ok) throw new Error(`List not visible: ${element}`);

      for (const item of items) {
        const itemLocator = listLocator.getByText(item);
        const count = await itemLocator.count();
        if (!count) throw new Error(`Item not found: ${item}`);
      }

      return pwOk(
        `Verified list items visible.\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolved.pageId}\\nList: ${element}\\nItems: ${items.length}`
      );
    } catch (error) {
      return pwError("Verify failed", error);
    }
  }
);

server.tool(
  "browser_verify_value",
  "Verify element value (best-effort; `ref` treated as locator selector)",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    type: z.enum(["textbox", "checkbox", "radio", "combobox", "slider"]).describe("Type of the element"),
    element: z.string().describe("Human-readable element description"),
    ref: z.string().describe("Target element reference; treated as a Playwright locator selector in this server"),
    value: z.string().describe('Value to verify. For checkbox/radio, use \"true\" or \"false\".')
  },
  async ({
    browserId,
    pageId,
    type,
    element,
    ref,
    value
  }: {
    browserId?: string;
    pageId?: string;
    type: "textbox" | "checkbox" | "radio" | "combobox" | "slider";
    element: string;
    ref: string;
    value: string;
  }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;
      const selector = ref?.trim();
      if (!selector) throw new Error("ref is required");

      const locator = page.locator(selector).first();
      if (type === "textbox" || type === "slider" || type === "combobox") {
        const actual = await locator.inputValue();
        if (actual !== value) throw new Error(`Expected \"${value}\", got \"${actual}\"`);
      } else if (type === "checkbox" || type === "radio") {
        const actual = await locator.isChecked();
        if (actual !== (value === "true")) throw new Error(`Expected \"${value}\", got \"${String(actual)}\"`);
      }

      return pwOk(
        `Verified value.\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolved.pageId}\\nElement: ${element}\\nType: ${type}\\nExpected: ${value}`
      );
    } catch (error) {
      return pwError("Verify failed", error);
    }
  }
);

server.tool(
  "browser_run_code",
  "Run Playwright code snippet (dangerous; disabled by default)",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    code: z
      .string()
      .describe(
        "Playwright code snippet to run. The snippet should access the `page` object to interact with the page. Can make multiple statements."
      ),
    timeoutMs: z.number().default(30000).describe("Timeout (milliseconds)")
  },
  async ({
    browserId,
    pageId,
    code,
    timeoutMs
  }: {
    browserId?: string;
    pageId?: string;
    code: string;
    timeoutMs: number;
  }) => {
    try {
      if (process.env.PATCHRIGHT_MCP_ENABLE_RUN_CODE !== "1") {
        throw new Error("browser_run_code is disabled. Set env PATCHRIGHT_MCP_ENABLE_RUN_CODE=1 to enable.");
      }

      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const resolved = getPage(resolvedBrowserId, pageId);
      const page = resolved.page;

      const context = vm.createContext({ page });
      const wrapped = `(async () => {\\n${code}\\n})()`;
      const run = () => vm.runInContext(wrapped, context, { timeout: Math.min(30000, timeoutMs) }) as unknown;
      const result = await Promise.race([
        Promise.resolve(run()),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs))
      ]);

      return pwOk(
        `Code executed.\\n\\nBrowser ID: ${resolvedBrowserId}\\nPage ID: ${resolved.pageId}\\nCurrent URL: ${page.url()}\\n\\nResult:\\n${formatEvalResult(
          result
        )}`,
        { code }
      );
    } catch (error) {
      return pwError("Failed to run code", error);
    }
  }
);

server.tool(
  "browser_close",
  "Close browser to free resources",
  {
    browserId: z.string().optional().describe("Browser ID (defaults to profile:default if omitted)")
  },
  async ({ browserId }: { browserId?: string }) => {
    try {
      const resolvedBrowserId = browserId ?? profileBrowserId("default");
      const instance = browserInstances.get(resolvedBrowserId);
      if (!instance) throw new Error(`Browser instance not found: ${resolvedBrowserId}`);

      try {
        await instance.context.close();
      } finally {
        if (instance.browser) {
          await instance.browser.close().catch(() => {});
        }
      }

      browserInstances.delete(resolvedBrowserId);
      if (instance.cleanupUserDataDir && instance.userDataDir) {
        await fs.rm(instance.userDataDir, { recursive: true, force: true });
      }

      return pwOk(`Successfully closed browser: ${resolvedBrowserId}`);
    } catch (error) {
      return pwError("Failed to close browser", error);
    }
  }
);

server.tool(
  "browser_cleanup",
  "Cleanup on-disk artifacts (profiles/downloads/traces) to prevent disk growth",
  {
    profiles: z.boolean().default(true).describe("Delete persisted browser profiles (will log out)"),
    downloads: z.boolean().default(true).describe("Delete downloaded files saved by the server"),
    traces: z.boolean().default(true).describe("Delete trace archives"),
    closeBrowsers: z.boolean().default(true).describe("Close all running browser contexts before cleanup")
  },
  async ({
    profiles,
    downloads,
    traces,
    closeBrowsers
  }: {
    profiles: boolean;
    downloads: boolean;
    traces: boolean;
    closeBrowsers: boolean;
  }) => {
    const lines: string[] = [];
    try {
      if (closeBrowsers) {
        const ids = [...browserInstances.keys()];
        for (const id of ids) {
          const instance = browserInstances.get(id);
          if (!instance) continue;
          try {
            await instance.context.close();
          } catch {
            // ignore
          }
          try {
            if (instance.browser) await instance.browser.close();
          } catch {
            // ignore
          }
          browserInstances.delete(id);
        }
        tracingSessions.clear();
        lines.push(`Closed browsers: ${ids.length}`);
      }

      if (profiles) {
        try {
          await fs.rm(PROFILES_DIR, { recursive: true, force: true });
          await fs.mkdir(PROFILES_DIR, { recursive: true });
          lines.push(`Profiles cleaned: ${PROFILES_DIR}`);
        } catch (e) {
          lines.push(`Profiles cleanup failed: ${stringifyError(e)}`);
        }
      }

      if (downloads) {
        try {
          await fs.rm(DOWNLOADS_DIR, { recursive: true, force: true });
          await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
          lines.push(`Downloads cleaned: ${DOWNLOADS_DIR}`);
        } catch (e) {
          lines.push(`Downloads cleanup failed: ${stringifyError(e)}`);
        }
      }

      if (traces) {
        try {
          await fs.rm(TRACES_DIR, { recursive: true, force: true });
          await fs.mkdir(TRACES_DIR, { recursive: true });
          tracingSessions.clear();
          lines.push(`Traces cleaned: ${TRACES_DIR}`);
        } catch (e) {
          lines.push(`Traces cleanup failed: ${stringifyError(e)}`);
        }
      }

      if (!profiles && !downloads && !traces) lines.push("Nothing to clean (all flags false).");
      return pwOk(lines.join("\n") || "Cleanup complete.");
    } catch (error) {
      return pwError("Failed to cleanup", error);
    }
  }
);

server.tool(
  "browser_install",
  "Install Patchright browser binaries (e.g. chromium)",
  {
    browser: z.enum(["chromium", "firefox", "webkit"]).default("chromium").describe("Browser to install"),
    timeoutMs: z.number().default(300000).describe("Timeout (milliseconds)")
  },
  async ({ browser, timeoutMs }: { browser: "chromium" | "firefox" | "webkit"; timeoutMs: number }) => {
    try {
      const cliPath = require.resolve("patchright/cli.js");
      const args = [cliPath, "install", browser];

      const proc = spawn(process.execPath, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => {
          proc.kill();
          reject(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.on("error", (err) => {
          clearTimeout(t);
          reject(err);
        });
        proc.on("close", (code) => {
          clearTimeout(t);
          resolve(code ?? -1);
        });
      });

      return pwOk(
        `Install finished.\n\nBrowser: ${browser}\nExit code: ${exitCode}\n\nSTDOUT:\n${stdout.trim()}\n\nSTDERR:\n${stderr.trim()}`
      );
    } catch (error) {
      return pwError("Failed to install browser", error);
    }
  }
);

// Tool 1c: Execute Script - Run custom JavaScript in the page context
server.tool(
  "execute_script",
  "Execute JavaScript in the page context and return the result (use `return` to return a value; `await` is allowed)",
  {
    browserId: z.string().describe("Browser ID from a previous browse operation"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the first page in the browser)"),
    code: z.string().describe("JavaScript snippet (function body). Example: `return localStorage.getItem('accessToken')`")
  },
  async ({ browserId, pageId, code }: { browserId: string; pageId?: string; code: string }) => {
    try {
      const resolved = getPage(browserId, pageId);
      const page = resolved.page;

      const wrapped = `(async () => { ${code}\n})()`;
      const result = (await page.evaluate(wrapped)) as unknown;

      return pwOk(
        `Script executed successfully.\n\nBrowser ID: ${browserId}\nPage ID: ${resolved.pageId}\nCurrent URL: ${page.url()}\n\nResult:\n${formatEvalResult(
          result
        )}`,
        { code }
      );
    } catch (error) {
      return pwError("Failed to execute script", error);
    }
  }
);

// Tool 1d: Request - Call HTTP APIs using the page's browser context (cookies/session preserved, no CORS)
server.tool(
  "request",
  "Send an HTTP request using the page's browser context (preserves cookies/session) and return JSON/text response",
  {
    browserId: z.string().describe("Browser ID from a previous browse operation"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the first page in the browser)"),
    url: z.string().url().describe("Request URL"),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      .default("GET")
      .describe("HTTP method"),
    headers: z.record(z.string()).optional().describe("Request headers"),
    data: z.any().optional().describe("Request body (string/object)"),
    responseType: z.enum(["json", "text"]).default("json").describe("How to parse the response body"),
    timeoutMs: z.number().default(30000).describe("Request timeout (milliseconds)")
  },
  async ({
    browserId,
    pageId,
    url,
    method,
    headers,
    data,
    responseType,
    timeoutMs
  }: {
    browserId: string;
    pageId?: string;
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
    headers?: Record<string, string>;
    data?: unknown;
    responseType: "json" | "text";
    timeoutMs: number;
  }) => {
    try {
      const resolved = getPage(browserId, pageId);
      const page = resolved.page;
      const context = page.context();

      const apiResponse = await context.request.fetch(url, {
        method,
        headers,
        data,
        timeout: timeoutMs
      });

      const status = apiResponse.status();
      const respHeaders = apiResponse.headers();

      let body: unknown;
      if (responseType === "text") {
        body = await apiResponse.text();
      } else {
        try {
          body = await apiResponse.json();
        } catch {
          body = await apiResponse.text();
        }
      }

      const bodyText = formatEvalResult(body);

      return pwOk(
        `Request completed.\n\n${method} ${url}\nStatus: ${status}\n\nResponse Headers:\n${formatEvalResult(
          respHeaders
        )}\n\nBody:\n${bodyText}`
      );
    } catch (error) {
      return pwError("Request failed", error);
    }
  }
);

// Tool 1e: Wait for Response - Capture a network response and return its body
server.tool(
  "wait_for_response",
  "Wait for a network response matching a URL substring and return its JSON/text body",
  {
    browserId: z.string().describe("Browser ID from a previous browse operation"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the first page in the browser)"),
    urlContains: z.string().describe("Substring to match against response URL"),
    timeoutMs: z.number().default(30000).describe("Timeout (milliseconds)"),
    responseType: z.enum(["json", "text"]).default("json").describe("How to parse the response body")
  },
  async ({
    browserId,
    pageId,
    urlContains,
    timeoutMs,
    responseType
  }: {
    browserId: string;
    pageId?: string;
    urlContains: string;
    timeoutMs: number;
    responseType: "json" | "text";
  }) => {
    try {
      const resolved = getPage(browserId, pageId);
      const page = resolved.page;

      const response = await page.waitForResponse((r) => r.url().includes(urlContains), { timeout: timeoutMs });

      let body: unknown;
      if (responseType === "text") {
        body = await response.text();
      } else {
        try {
          body = await response.json();
        } catch {
          body = await response.text();
        }
      }

      return pwOk(
        `Matched response.\n\nURL: ${response.url()}\nStatus: ${response.status()}\n\nHeaders:\n${formatEvalResult(
          response.headers()
        )}\n\nBody:\n${formatEvalResult(body)}`
      );
    } catch (error) {
      return pwError("Failed to wait for response", error);
    }
  }
);

// Tool 2: Interact - Perform simple interactions on a page
server.tool(
  "interact",
  "Perform simple interactions on a page",
  {
    browserId: z.string().describe("Browser ID from a previous browse operation"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    action: z.enum(["click", "fill", "select"]).describe("The type of interaction to perform"),
    selector: z.string().describe("CSS selector for the element to interact with"),
    value: z.string().optional().describe("Value for fill/select actions")
  },
  async ({ browserId, pageId, action, selector, value }: { 
    browserId: string; 
    pageId?: string; 
    action: "click" | "fill" | "select"; 
    selector: string; 
    value?: string 
  }) => {
    try {
      const resolved = getPage(browserId, pageId);
      const page = resolved.page;
      
      // Perform the requested action
      let actionResult = '';
      switch (action) {
        case "click":
          await page.click(selector);
          actionResult = `Clicked on element: ${selector}`;
          break;
        case "fill":
          if (!value) {
            throw new Error("Value is required for fill action");
          }
          await page.fill(selector, value);
          actionResult = `Filled element ${selector} with value: ${value}`;
          break;
        case "select":
          if (!value) {
            throw new Error("Value is required for select action");
          }
          await page.selectOption(selector, value);
          actionResult = `Selected option ${value} in element: ${selector}`;
          break;
      }
      
      // Wait a moment for any results of the interaction
      await page.waitForTimeout(1000);
      
      // Take a screenshot of the result
      const screenshotPath = path.join(TEMP_DIR, `screenshot-${resolved.pageId}-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
      
      // Get current URL after interaction
      const currentUrl = page.url();
      
      return pwOk(`Successfully performed action.\n\n${actionResult}\n\nCurrent URL: ${currentUrl}\n\nScreenshot saved to: ${screenshotPath}`);
    } catch (error) {
      return pwError("Failed to interact with page", error);
    }
  }
);

// Tool 3: Extract - Get information from the current page
server.tool(
  "extract",
  "Extract information from the current page as text, html, or screenshot",
  {
    browserId: z.string().describe("Browser ID from a previous browse operation"),
    pageId: z.string().optional().describe("Optional Page ID (defaults to the active page)"),
    type: z.enum(["text", "html", "screenshot"]).describe("Type of content to extract")
  },
  async ({ browserId, pageId, type }: { 
    browserId: string; 
    pageId?: string; 
    type: "text" | "html" | "screenshot" 
  }) => {
    try {
      const resolved = getPage(browserId, pageId);
      const page = resolved.page;
      
      let extractedContent = '';
      let screenshotPath = '';
      let images: Array<{ mimeType: string; data: Buffer }> = [];
      
      // Extract content based on requested type
      switch (type) {
        case "text":
          // Get visible text with stealth isolation
          extractedContent = await page.evaluate(`
            Array.from(document.querySelectorAll('body, body *'))
              .filter(element => {
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
              })
              .map(element => element.textContent)
              .filter(text => text && text.trim().length > 0)
              .join('\\n')
          `) as string;
          break;
        case "html":
          // Get HTML content
          extractedContent = await page.content();
          break;
        case "screenshot":
          // Take a screenshot
          screenshotPath = path.join(TEMP_DIR, `screenshot-${resolved.pageId}-${Date.now()}.png`);
          const buffer = (await page.screenshot()) as Buffer;
          await fs.writeFile(screenshotPath, buffer);
          images = [{ mimeType: "image/png", data: scaleImageToFitMessage(buffer, "png") }];
          extractedContent = `Screenshot saved to: ${screenshotPath}`;
          break;
      }
      
      if (type === "screenshot") return pwOk(extractedContent, { images });

      const text =
        type === "text"
          ? extractedContent.substring(0, 2000) + (extractedContent.length > 2000 ? "..." : "")
          : `Extracted HTML content (${extractedContent.length} characters). First 100 characters:\n${extractedContent.substring(0, 100)}...`;
      return pwOk(text);
    } catch (error) {
      return pwError("Failed to extract content", error);
    }
  }
);

// Tool 4: Close - Close browser to free resources
server.tool(
  "close",
  "Close browser to free resources",
  {
    browserId: z.string().describe("Browser ID to close")
  },
  async ({ browserId }: { browserId: string }) => {
    try {
      // Get the browser instance
      const instance = browserInstances.get(browserId);
      if (!instance) {
        throw new Error(`Browser instance not found: ${browserId}`);
      }
      
      // Close the context/browser
      try {
        await instance.context.close();
      } finally {
        if (instance.browser) {
          await instance.browser.close().catch(() => {});
        }
      }
      
      // Remove from the map
      browserInstances.delete(browserId);

      if (instance.cleanupUserDataDir && instance.userDataDir) {
        await fs.rm(instance.userDataDir, { recursive: true, force: true });
      }
      
      return pwOk(`Successfully closed browser: ${browserId}`);
    } catch (error) {
      return pwError("Failed to close browser", error);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Patchright Lite MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
