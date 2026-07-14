import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the gloop version from package.json, located relative to this
 * module (works from both src/ via tsx and the compiled dist/ output,
 * since both sit one level below the package root).
 */
export function getVersion(baseUrl: string = import.meta.url): string {
	const dir = path.dirname(fileURLToPath(baseUrl));
	const pkgPath = path.resolve(dir, "..", "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
	if (!pkg.version) throw new Error(`No version field in ${pkgPath}`);
	return pkg.version;
}
