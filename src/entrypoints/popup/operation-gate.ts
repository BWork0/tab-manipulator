export interface PopupOperationGate {
  isPending(): boolean;
  tryAcquire(): (() => void) | null;
  subscribe(listener: (pending: boolean) => void): () => void;
}

/** Coordinates popup actions so only one browser operation can be submitted at a time. */
export function createPopupOperationGate(): PopupOperationGate {
  const listeners = new Set<(pending: boolean) => void>();
  let pending = false;

  function notify(): void {
    for (const listener of listeners) {
      listener(pending);
    }
  }

  return {
    isPending: () => pending,
    tryAcquire() {
      if (pending) {
        return null;
      }

      pending = true;
      notify();
      let released = false;

      return () => {
        if (released) {
          return;
        }

        released = true;
        pending = false;
        notify();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
