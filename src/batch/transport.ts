/** A fetch that failed to reach the provider at all (DNS, connect, reset) rather than a provider answer: the batch's state is unknown, not failed. */
export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  return err.name === 'TypeError' || err.name === 'AbortError' || (typeof code === 'string' && code.startsWith('UND_ERR'));
}

/** Polls through `fetchFn`; a transport failure answers `undefined`, which a poll reports as the batch still running. */
export async function fetchForPoll(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<Response | undefined> {
  try {
    return await fetchFn(url, init);
  } catch (err) {
    if (isTransportError(err)) return undefined;
    throw err;
  }
}
