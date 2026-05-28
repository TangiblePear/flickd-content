import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const run = (args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

export async function commitAndMaybePush(message) {
  try {
    run(["rev-parse", "--git-dir"]);
  } catch {
    return { skipped: "no_git_repo" };
  }

  run(["add", "content/"]);
  const status = run(["status", "--porcelain", "content/"]);
  if (!status) return { skipped: "no_changes" };

  run(["commit", "-m", message]);
  const sha = run(["rev-parse", "HEAD"]);

  if (process.env.GIT_AUTO_PUSH === "true") {
    const remote = process.env.GIT_REMOTE ?? "origin";
    const branch = process.env.GIT_BRANCH ?? "main";
    try {
      run(["push", remote, branch]);
      return { committed: sha, pushed: true };
    } catch (err) {
      return { committed: sha, pushed: false, pushError: String(err.message ?? err) };
    }
  }
  return { committed: sha, pushed: false };
}
