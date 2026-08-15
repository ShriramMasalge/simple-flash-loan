// cross-fetch shim: its browser build re-exports an unbound window.fetch,
// which throws "Illegal invocation" when called from module scope in Chrome.
const boundFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, init);

export const fetch = boundFetch;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export default boundFetch;