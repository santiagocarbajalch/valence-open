import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Cmd {
  name: string;
  description: string;
  kind: "command" | "skill";
}

// pull `description:` (or first heading) from a SKILL.md / command .md frontmatter
function describe(text: string): string {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const d = fm[1].match(/^description:\s*["']?(.+?)["']?\s*$/m);
    if (d) return d[1].slice(0, 120);
  }
  const h = text.match(/^#\s+(.+)$/m);
  return h ? h[1].slice(0, 120) : "";
}

async function readCommands(dir: string): Promise<Cmd[]> {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return Promise.all(
    files.map(async (f) => {
      const text = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
      return { name: f.replace(/\.md$/, ""), description: describe(text), kind: "command" as const };
    }),
  );
}

async function readSkills(dir: string): Promise<Cmd[]> {
  let dirs: string[];
  try {
    // most skills are SYMLINKS into the shared skills cache — include them
    dirs = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const cmds: Cmd[] = [];
  await Promise.all(
    dirs.map(async (name) => {
      const text = await fs.readFile(path.join(dir, name, "SKILL.md"), "utf8").catch(() => "");
      if (text) cmds.push({ name, description: describe(text), kind: "skill" });
    }),
  );
  return cmds;
}

export async function GET() {
  const home = os.homedir();
  const [commands, skills] = await Promise.all([
    readCommands(path.join(home, ".claude", "commands")),
    readSkills(path.join(home, ".claude", "skills")),
  ]);
  // commands first (the operator's own), then skills, alphabetical within
  const sortByName = (a: Cmd, b: Cmd) => a.name.localeCompare(b.name);
  return NextResponse.json({
    commands: commands.sort(sortByName),
    skills: skills.sort(sortByName),
  });
}
