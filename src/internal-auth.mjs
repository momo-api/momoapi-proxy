export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function localRequestToken(request) {
  return request?.headers?.["x-local-token"] || request?.headers?.authorization?.replace(/^Bearer\s+/i, "");
}

export function isAuthorizedLoopbackRequest(request, remoteAddress, expectedToken) {
  return isLoopbackAddress(remoteAddress) && (!expectedToken || localRequestToken(request) === expectedToken);
}
