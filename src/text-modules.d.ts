/**
 * Cloudflare Workers treats `*.html` imports as text modules (default module
 * rule of type `Text`), exposing the file contents as a default string export.
 * This declaration lets TypeScript resolve those imports.
 */
declare module "*.html" {
	const content: string;
	export default content;
}
