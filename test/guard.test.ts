import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBashCommand, checkWritePath } from "../src/worker.js";

function blocked(cmd: string): void {
	const reason = checkBashCommand(cmd);
	assert.equal(typeof reason, "string", `expected blocked: ${cmd}`);
	assert.ok((reason as string).startsWith("gloop guard:"), `reason should be prefixed: ${reason}`);
}

function allowed(cmd: string): void {
	assert.equal(checkBashCommand(cmd), undefined, `expected allowed: ${cmd}`);
}

test("checkBashCommand blocks git push", () => {
	blocked("git push");
	blocked("git push --force origin x");
	blocked("cd repo && git push origin HEAD");
});

test("checkBashCommand blocks git commit", () => {
	blocked("git commit -m x");
	blocked("git add -A && git commit -m 'wip'");
});

test("checkBashCommand blocks history rewrites", () => {
	blocked("git rebase -i");
	blocked("git rebase main");
	blocked("git reset --hard HEAD~1");
	blocked("git filter-branch --all");
});

test("checkBashCommand blocks gh pr commands", () => {
	blocked("gh pr create");
	blocked("gh pr merge 12");
	blocked("gh pr view 3");
});

test("checkBashCommand blocks gh issue state changes", () => {
	blocked("gh issue close 1");
	blocked("gh issue create --title x");
	blocked("gh issue edit 4 --add-label bug");
	blocked("gh issue reopen 2");
});

test("checkBashCommand blocks gh repo/release/api", () => {
	blocked("gh api repos/foo/bar");
	blocked("gh api ...");
	blocked("gh repo delete foo/bar");
	blocked("gh release create v1.0.0");
});

test("checkBashCommand blocks git remote", () => {
	blocked("git remote add origin git@github.com:x/y.git");
	blocked("git remote -v");
});

test("checkBashCommand blocks branch switching", () => {
	blocked("git checkout main");
	blocked("git checkout -b feature");
	blocked("git switch -c foo");
	blocked("git switch main");
});

test("checkBashCommand blocks writes to gloop config", () => {
	blocked("echo x > .gloop.json");
	blocked("echo x >> .gloop/PROMPT.md");
	blocked("rm .gloop.json");
	blocked("mv .gloop.json backup.json");
	blocked("cp other.json .gloop.json");
	blocked("sed -i 's/a/b/' .gloop/PROMPT.md");
	blocked("cat foo | tee .gloop.json");
});

test("checkBashCommand allows read-only git commands", () => {
	allowed("git status");
	allowed("git diff");
	allowed("git log");
	allowed("git stash list");
	allowed("git branch --show-current");
});

test("checkBashCommand allows gh issue reads", () => {
	allowed("gh issue view 5 --comments");
	allowed("gh issue list");
});

test("checkBashCommand allows reverting files with checkout --", () => {
	allowed("git checkout -- src/file.ts");
});

test("checkBashCommand allows read-only access to gloop config", () => {
	allowed("grep gloop .gloop.json");
	allowed("cat .gloop/PROMPT.md");
});

test("checkBashCommand allows ordinary commands", () => {
	allowed("npm test");
	allowed("ls -la src");
	allowed("echo hello > /tmp/out.txt");
});

test("checkWritePath blocks gloop configuration paths", () => {
	assert.equal(typeof checkWritePath(".gloop.json"), "string");
	assert.equal(typeof checkWritePath(".gloop/PROMPT.md"), "string");
	assert.equal(typeof checkWritePath("/repo/.gloop.json"), "string");
	assert.equal(typeof checkWritePath("some/dir/.gloop/config.md"), "string");
	assert.equal(typeof checkWritePath("C:\\repo\\.gloop.json"), "string");
});

test("checkWritePath allows normal paths", () => {
	assert.equal(checkWritePath("src/anything.ts"), undefined);
	assert.equal(checkWritePath("test/guard.test.ts"), undefined);
	assert.equal(checkWritePath("README.md"), undefined);
	assert.equal(checkWritePath("src/gloop.ts"), undefined);
});
