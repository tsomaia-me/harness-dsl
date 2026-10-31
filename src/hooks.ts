export const HOOK_PATH = '/internal/hook';

export function hookEndpointUrl(serverUrl: string, protocolName: string, runId: string): string {
  const query = new URLSearchParams({ protocol: protocolName, runId });
  return `${serverUrl.replace(/\/$/, '')}${HOOK_PATH}?${query.toString()}`;
}
