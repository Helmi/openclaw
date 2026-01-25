import fs from "node:fs/promises";
import path from "node:path";

import { confirm, isCancel, select, text } from "@clack/prompts";

import type { CommandHandler } from "./commands-types.js";

type PlansArgs = {
  action: "list" | "show" | "rename" | "trash" | "help";
  a?: string;
  b?: string;
};

function parsePlansArgs(raw: string): PlansArgs {
  const trimmed = raw.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const cmd = parts[0]?.toLowerCase();
  if (cmd !== "/plans") return { action: "help" };
  const sub = parts[1]?.toLowerCase();
  if (!sub || sub === "list") return { action: "list" };
  if (sub === "help") return { action: "help" };
  if (sub === "show") return { action: "show", a: parts[2] };
  if (sub === "rename") return { action: "rename", a: parts[2], b: parts[3] };
  if (sub === "trash" || sub === "delete" || sub === "rm") return { action: "trash", a: parts[2] };
  // Default: treat unknown as help.
  return { action: "help" };
}

async function listPlanDirs(plansDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(plansDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function readFirstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      const text = await fs.readFile(p, "utf-8");
      return text;
    } catch (err: any) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}

export const handlePlansCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;

  // Match on normalized command body
  if (!params.command.commandBodyNormalized.startsWith("/plans")) return null;

  const raw =
    params.ctx.BodyForCommands ??
    params.ctx.CommandBody ??
    params.ctx.RawBody ??
    params.ctx.BodyStripped ??
    params.ctx.Body ??
    "/plans";

  const args = parsePlansArgs(raw);

  const plansDir = path.join(params.workspaceDir, "plans");

  const isInteractiveCli =
    params.ctx.CommandSource === "cli" &&
    Boolean(process.stdin.isTTY) &&
    Boolean(process.stdout.isTTY);

  if (args.action === "help") {
    return {
      shouldContinue: false,
      reply: {
        text:
          "Usage:\n" +
          "  /plans list\n" +
          "  /plans show <name>\n" +
          "  /plans rename <old> <new>\n" +
          "  /plans trash <name>\n\n" +
          "TUI:\n" +
          "  /plans (with no args) opens an interactive picker in the CLI.\n\n" +
          "Notes:\n" +
          "- Plans are stored under workspace/plans/.\n" +
          "- Use /plan <goal> to start a new plan; /plans helps manage saved plan folders.",
      },
    };
  }

  if (args.action === "list") {
    const names = await listPlanDirs(plansDir);
    if (names.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: "No plans found yet. Create one with: /plan <goal>" },
      };
    }

    // Interactive picker only when running in the CLI TUI.
    // For chat channels (Discord/Telegram/etc.), return plain text.
    const wantsInteractive =
      isInteractiveCli && (raw.trim() === "/plans" || raw.trim() === "/plans list");
    if (wantsInteractive) {
      const selected = await select({
        message: "Select a plan",
        options: names
          .slice()
          .reverse()
          .map((n) => ({ label: n, value: n })),
      });
      if (isCancel(selected)) {
        return { shouldContinue: false, reply: { text: "Cancelled." } };
      }

      const planName = String(selected);
      const action = await select({
        message: `Action for ${planName}`,
        options: [
          { label: "Show", value: "show" },
          { label: "Rename", value: "rename" },
          { label: "Trash", value: "trash" },
        ],
      });
      if (isCancel(action)) {
        return { shouldContinue: false, reply: { text: "Cancelled." } };
      }

      if (action === "show") {
        const planDir = path.join(plansDir, planName);
        const planMd = await readFirstExisting([
          path.join(planDir, "plan.md"),
          path.join(planDir, "README.md"),
        ]);
        if (!planMd) {
          return {
            shouldContinue: false,
            reply: { text: `No plan.md found for '${planName}'. Looked in: ${planDir}` },
          };
        }
        const trimmed = planMd.trim();
        const preview =
          trimmed.length > 6000 ? `${trimmed.slice(0, 6000)}\n\n…(truncated)` : trimmed;
        return { shouldContinue: false, reply: { text: `Plan: ${planName}\n\n${preview}` } };
      }

      if (action === "rename") {
        const next = await text({
          message: `Rename '${planName}' to:`,
          initialValue: planName,
          validate: (v) => (!v?.trim() ? "Name required" : undefined),
        });
        if (isCancel(next)) return { shouldContinue: false, reply: { text: "Cancelled." } };
        const toName = String(next).trim();
        if (toName && toName !== planName) {
          await fs.rename(path.join(plansDir, planName), path.join(plansDir, toName));
        }
        return {
          shouldContinue: false,
          reply: { text: `Renamed plan '${planName}' → '${toName}'.` },
        };
      }

      if (action === "trash") {
        const ok = await confirm({ message: `Move '${planName}' to trash?` });
        if (isCancel(ok) || ok === false) {
          return { shouldContinue: false, reply: { text: "Cancelled." } };
        }
        const fromDir = path.join(plansDir, planName);
        const trashDir = path.join(plansDir, ".trash");
        await fs.mkdir(trashDir, { recursive: true });
        const stamped = `${planName}__${new Date().toISOString().replace(/[:.]/g, "-")}`;
        const toDir = path.join(trashDir, stamped);
        await fs.rename(fromDir, toDir);
        return { shouldContinue: false, reply: { text: `Moved plan '${planName}' to trash.` } };
      }
    }

    const lines = ["Plans:", ...names.map((n) => `- ${n}`), "", "Tip: /plans show <name>"];
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (args.action === "show") {
    const name = String(args.a ?? "").trim();
    if (!name) {
      return { shouldContinue: false, reply: { text: "Usage: /plans show <name>" } };
    }

    const planDir = path.join(plansDir, name);
    const planMd = await readFirstExisting([
      path.join(planDir, "plan.md"),
      path.join(planDir, "README.md"),
    ]);

    if (!planMd) {
      return {
        shouldContinue: false,
        reply: { text: `No plan.md found for '${name}'. Looked in: ${planDir}` },
      };
    }

    const trimmed = planMd.trim();
    const preview = trimmed.length > 1800 ? `${trimmed.slice(0, 1800)}\n\n…(truncated)` : trimmed;
    return {
      shouldContinue: false,
      reply: { text: `Plan: ${name}\n\n${preview}` },
    };
  }

  if (args.action === "rename") {
    const from = String(args.a ?? "").trim();
    const to = String(args.b ?? "").trim();
    if (!from || !to) {
      return { shouldContinue: false, reply: { text: "Usage: /plans rename <old> <new>" } };
    }
    const fromDir = path.join(plansDir, from);
    const toDir = path.join(plansDir, to);

    await fs.mkdir(plansDir, { recursive: true });
    await fs.rename(fromDir, toDir);

    return {
      shouldContinue: false,
      reply: { text: `Renamed plan '${from}' → '${to}'.` },
    };
  }

  if (args.action === "trash") {
    const name = String(args.a ?? "").trim();
    if (!name) {
      return { shouldContinue: false, reply: { text: "Usage: /plans trash <name>" } };
    }

    const fromDir = path.join(plansDir, name);
    const trashDir = path.join(plansDir, ".trash");
    await fs.mkdir(trashDir, { recursive: true });

    const stamped = `${name}__${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const toDir = path.join(trashDir, stamped);
    await fs.rename(fromDir, toDir);

    return {
      shouldContinue: false,
      reply: { text: `Moved plan '${name}' to trash.` },
    };
  }

  return null;
};
