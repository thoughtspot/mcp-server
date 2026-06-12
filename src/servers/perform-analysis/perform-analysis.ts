import PERFORM_ANALYSIS_HTML from "./perform-analysis.html";

/**
 * Content Security Policy metadata for the perform-analysis MCP App resource.
 *
 * Declares which external origins the sandboxed iframe is allowed to talk to
 * (`connectDomains`) and load static assets from (`resourceDomains`). The host
 * uses this to construct the iframe's CSP headers.
 */
export const PERFORM_ANALYSIS_CSP_META = {
	ui: {
		csp: {
			// Allow the SDK's API calls to the ThoughtSpot instance
			connectDomains: [
				"https://agent.thoughtspot.app",
				"https://cdn.jsdelivr.net",
			],
			// Allow loading the SDK script from the CDN, and allow the
			// ThoughtSpot SDK to embed the ThoughtSpot host in an iframe (frame-src)
			resourceDomains: [
				"https://agent.thoughtspot.app",
				"https://cdn.jsdelivr.net",
				"https://assets.claude.ai",
			],
		},
	},
};

/**
 * HTML document for the perform-analysis MCP App. Rendered inside a sandboxed iframe by
 * the host; the inline script handles the MCP Apps handshake and swaps the
 * displayed image based on the tool result.
 */
export { PERFORM_ANALYSIS_HTML };
