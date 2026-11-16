// The view's decisions, without Obsidian, so they can be tested.

/** Whether a vault `modify` event for `modifiedPath` concerns the open file. */
export function appliesTo(modifiedPath: string, currentPath: string | null | undefined): boolean {
  return !!currentPath && modifiedPath === currentPath;
}

/**
 * Tokens for async renders: only the latest `begin()` is current, and
 * `invalidate()` (the file was closed) makes every token stale.
 */
export class RenderSequencer {
  private n = 0;

  begin(): number {
    return ++this.n;
  }

  isCurrent(token: number): boolean {
    return token === this.n;
  }

  invalidate(): void {
    this.n++;
  }
}
