import { isAbsolute, relative, sep } from "node:path";

export function normalizeWorkspaceAlias(alias: string): string {
  const normalized = alias.trim().toLocaleLowerCase("en-US");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,31}$/u.test(normalized)) {
    throw new Error("项目别名必须为 1～32 个字母、数字、点、下划线或连字符");
  }
  return normalized;
}

export function isWorkspacePathAllowed(path: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => {
    const relativePath = relative(platformPath(root), platformPath(path));
    return relativePath === ""
      || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
  });
}

function platformPath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}
