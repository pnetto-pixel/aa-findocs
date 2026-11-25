import { useCallback, useEffect, useRef, useState } from "react";
import { PREFERENCE_DEFAULTS } from "./rebalanceBudget.js";
import { localContributionDate } from "./contributionCapacity.js";

export function accountHeaders(auth) {
  return auth?.kind === "google" ? { "x-google-token": auth.googleToken } : { "x-app-password": auth?.password };
}

const endpoint = "/api/holdings?resource=preferences";

export function useHoldingsPreferences(auth, onAuthFail) {
  const [state, setState] = useState({ preferences: PREFERENCE_DEFAULTS, revision: null, phase: "loading", error: null });
  const pending = useRef(null);
  const alive = useRef(false);
  const load = useCallback(async () => {
    if (pending.current) return;
    const id = Symbol();
    pending.current = id;
    try {
      const res = await fetch(endpoint, { headers: accountHeaders(auth), cache: "no-store" });
      if (res.status === 401 && alive.current) { onAuthFail(); return; }
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (!data.preferences || !Object.hasOwn(data, "revision")) throw new Error();
      if (alive.current && pending.current === id) {
        setState(s => ({ ...data, phase: "ready", error: s.phase === "ready" ? s.error : null }));
      }
    } catch {
      if (alive.current && pending.current === id) {
        setState(s => ({ ...s, phase: "unavailable", error: "Settings could not be loaded." }));
      }
    } finally {
      if (pending.current === id) pending.current = null;
    }
  }, [auth, onAuthFail]);

  useEffect(() => {
    alive.current = true;
    load();
    const onVisibility = () => { if (!document.hidden) load(); };
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      pending.current = null;
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  async function save(patch) {
    if (state.phase !== "ready" || pending.current) return;
    const id = Symbol();
    pending.current = id;
    setState(s => ({ ...s, phase: "saving", error: null }));
    try {
      const res = await fetch(endpoint, {
        method: "PUT", headers: { ...accountHeaders(auth), "Content-Type": "application/json" },
        body: JSON.stringify({ patch, expectedRevision: state.revision }),
      });
      if (res.status === 401 && alive.current) { onAuthFail(); return; }
      if (!res.ok && res.status !== 409) throw new Error();
      const data = await res.json();
      if (!data.preferences || !Object.hasOwn(data, "revision")) throw new Error();
      if (alive.current && pending.current === id) {
        setState({ ...data, phase: "ready", error: res.status === 409
          ? "Settings changed on another device. The latest settings are shown. Apply your change again if needed." : null });
      }
    } catch {
      if (alive.current && pending.current === id) setState(s => ({ ...s, phase: "unavailable", error: "Save could not be confirmed. Reload settings before continuing." }));
    } finally {
      if (pending.current === id) pending.current = null;
    }
  }

  return { ...state, save, reload: load };
}

export function useContributionDate() {
  const [date, setDate] = useState(localContributionDate);
  useEffect(() => {
    const update = () => setDate(localContributionDate());
    const timer = setInterval(update, 10000);
    window.addEventListener("focus", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); };
  }, []);
  return date;
}

export function useContributionSnapshot(auth, enabled, month, onAuthFail) {
  const [state, setState] = useState({ month: null, phase: "loading", snapshot: null });
  useEffect(() => {
    if (!enabled) return;
    let current;
    const load = async (showLoading = false) => {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      if (showLoading) setState({ month, phase: "loading", snapshot: null });
      try {
        const res = await fetch("/api/contributions-history", {
          headers: accountHeaders(auth), cache: "no-store", signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (res.status === 401) { onAuthFail(); return; }
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (!data.history || typeof data.history !== "object" || Array.isArray(data.history)) throw new Error();
        if (!controller.signal.aborted) setState({ month, phase: "ready", snapshot: data.history[month] || null });
      } catch {
        if (!controller.signal.aborted) setState({ month, phase: "unavailable", snapshot: null });
      }
    };
    const refresh = () => load(true);
    refresh();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30000);
    window.addEventListener("focus", refresh);
    window.addEventListener("contributions-saved", refresh);
    return () => {
      current?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("contributions-saved", refresh);
    };
  }, [auth, enabled, month, onAuthFail]);
  return state.month === month ? state : { month, phase: "loading", snapshot: null };
}
