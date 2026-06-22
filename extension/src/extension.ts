import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const pexec = promisify(execFile);

/**
 * the_brain VS Code extension (PRD §21 V2).
 *
 * Thin client over the `brain` CLI: it shells out to the configured command in
 * the workspace folder so all the heavy lifting (Kuzu, embeddings) stays in the
 * CLI process. Commands surface memory search, per-file context, ingestion,
 * curation, and the interactive graph explorer (in a webview).
 */

const output = vscode.window.createOutputChannel("the_brain");

function workspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Run `brain <args>` in the workspace folder; returns stdout. */
async function runBrain(args: string[]): Promise<string> {
  const cli = vscode.workspace.getConfiguration("theBrain").get<string>("cli", "brain");
  const cwd = workspaceCwd();
  if (!cwd) throw new Error("Open a folder/workspace first.");
  // The cli setting may be a multi-word command (e.g. "node /path/brain.js").
  const parts = cli.split(" ").filter(Boolean);
  const cmd = parts[0];
  const { stdout } = await pexec(cmd, [...parts.slice(1), ...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function withProgress<T>(title: string, fn: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
}

function show(title: string, body: string): void {
  output.clear();
  output.appendLine(title);
  output.appendLine("─".repeat(title.length));
  output.appendLine(body.trim() || "(no results)");
  output.show(true);
}

async function search(): Promise<void> {
  const query = await vscode.window.showInputBox({ prompt: "Search project memory", placeHolder: "e.g. OAuth authentication" });
  if (!query) return;
  try {
    const out = await withProgress("the_brain: searching…", () => runBrain(["query", query]));
    show(`🧠 Context for: ${query}`, out);
  } catch (e) {
    vscode.window.showErrorMessage(`the_brain: ${(e as Error).message}`);
  }
}

async function contextForFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("the_brain: no active file.");
    return;
  }
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  try {
    const out = await withProgress("the_brain: loading context…", () => runBrain(["query", `working on ${rel}`]));
    show(`🧠 Context for ${rel}`, out);
  } catch (e) {
    vscode.window.showErrorMessage(`the_brain: ${(e as Error).message}`);
  }
}

async function ingest(): Promise<void> {
  try {
    const out = await withProgress("the_brain: ingesting repository…", () => runBrain(["ingest"]));
    vscode.window.showInformationMessage(`the_brain: ${out.trim()}`);
  } catch (e) {
    vscode.window.showErrorMessage(`the_brain: ${(e as Error).message}`);
  }
}

async function curate(): Promise<void> {
  try {
    const out = await withProgress("the_brain: curating…", () => runBrain(["curate"]));
    show("🧹 Curation", out);
  } catch (e) {
    vscode.window.showErrorMessage(`the_brain: ${(e as Error).message}`);
  }
}

async function explore(): Promise<void> {
  const file = join(tmpdir(), `brain-graph-${Date.now()}.html`);
  try {
    await withProgress("the_brain: building graph…", () => runBrain(["explore", file]));
    const html = readFileSync(file, "utf8");
    const panel = vscode.window.createWebviewPanel("theBrainGraph", "🧠 the_brain Graph", vscode.ViewColumn.Active, {
      enableScripts: true,
    });
    panel.webview.html = html;
  } catch (e) {
    vscode.window.showErrorMessage(`the_brain: ${(e as Error).message}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("theBrain.search", search),
    vscode.commands.registerCommand("theBrain.contextForFile", contextForFile),
    vscode.commands.registerCommand("theBrain.ingest", ingest),
    vscode.commands.registerCommand("theBrain.curate", curate),
    vscode.commands.registerCommand("theBrain.explore", explore),
  );
}

export function deactivate(): void {
  output.dispose();
}
