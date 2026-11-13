export interface BundledPackage {
	name: string;
	version: string;
	license: string;
	licenceText: string;
}
export function packageRootOf(moduleId: string): string | undefined;
export function findLicenceFile(dir: string): string | undefined;
export function collectPackages(moduleIds: Iterable<string>): BundledPackage[];
export function readVendorHeader(file: string): string;
export function renderThirdPartyNotices(packages: BundledPackage[], vendorHeader?: string): string;
export function noticesPlugin(options: { projectRoot: string; pluginDir: string }): { name: string; generateBundle(options: unknown, bundle: Record<string, unknown>): void; writeBundle(): void };
