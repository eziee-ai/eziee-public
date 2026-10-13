import { useEffect, useState } from "react";

/** `value`, but only after it has stopped changing for `ms`. For search boxes: one request per pause, not per key. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
