export type PackageJsonWithOptionalDependencies = {
  optionalDependencies?: Record<string, string>;
};

export function opentuiNativePackagesFromPackageJson(packageJson: PackageJsonWithOptionalDependencies): string[] {
  return Object.keys(packageJson.optionalDependencies ?? {}).filter((name) => name.startsWith("@opentui/core-"));
}
