import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAccountUsage } from "@/api/accountUsage";

const COUNTDOWN_INTERVAL_MS = 1000;

function remainingFrom(targetMs?: number): number {
  if (targetMs === undefined) return 0;
  return Math.max(0, targetMs - Date.now());
}

export function useAccountUsage() {
  return useQuery({
    queryKey: ["account-usage"],
    queryFn: fetchAccountUsage,
    refetchInterval: 30000,
    staleTime: 10000,
    retry: false,
  });
}

export function useCountdown(targetMs?: number): {
  remainingMs: number;
  isPast: boolean;
} {
  const [remainingMs, setRemainingMs] = useState(() => remainingFrom(targetMs));

  useEffect(() => {
    const initial = remainingFrom(targetMs);
    setRemainingMs(initial);
    if (targetMs === undefined || initial <= 0) return;

    const timer = setInterval(() => {
      const next = remainingFrom(targetMs);
      setRemainingMs(next);
      if (next <= 0) {
        clearInterval(timer);
      }
    }, COUNTDOWN_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [targetMs]);

  return { remainingMs, isPast: targetMs !== undefined && remainingMs <= 0 };
}
