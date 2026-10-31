export const HOOK_PATH = '/internal/hook';

export function hookEndpointUrl(serverUrl: string, invocationId: string): string {
  const query = new URLSearchParams({ invocation: invocationId });
  return `${serverUrl.replace(/\/$/, '')}${HOOK_PATH}?${query.toString()}`;
}
