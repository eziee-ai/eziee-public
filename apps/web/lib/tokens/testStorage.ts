import { resetStoreMemory } from "./localStore";

/** A Map-backed `localStorage` for node tests. */
export function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  resetStoreMemory();
  return data;
}

/** No storage, or (`throwing`) storage whose every access throws, as blocked site data does. */
export function removeStorage(options: { throwing?: boolean } = {}): void {
  if (options.throwing) {
    const fail = () => {
      throw new Error("SecurityError: storage is blocked");
    };
    Object.defineProperty(globalThis, "localStorage", { get: fail, configurable: true });
  } else {
    Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
  }
  resetStoreMemory();
}
