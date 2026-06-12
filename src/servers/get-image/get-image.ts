import GET_IMAGE_HTML from "./get-image.html";

/**
 * Content Security Policy metadata for the get-image MCP App resource.
 *
 * Declares which external origins the sandboxed iframe is allowed to talk to
 * (`connectDomains`) and load static assets from (`resourceDomains`). The host
 * uses this to construct the iframe's CSP headers.
 */
export const GET_IMAGE_CSP_META = {
	ui: {
		csp: {
			// Allow the SDK's API calls to the ThoughtSpot instance
			connectDomains: ["https://agent.thoughtspot.app"],
			// Allow loading the SDK script from the CDN, and allow the
			// ThoughtSpot SDK to embed the ThoughtSpot host in an iframe (frame-src)
			resourceDomains: ["https://agent.thoughtspot.app"],
		},
	},
};

/**
 * HTML document for the get-image MCP App. Rendered inside a sandboxed iframe by
 * the host; the inline script handles the MCP Apps handshake and swaps the
 * displayed image based on the tool result.
 */
export { GET_IMAGE_HTML };
