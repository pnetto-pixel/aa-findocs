// src/Transactions.jsx
// Chunk 1A: shell with auth-aware fetch/save, empty list placeholder.
// Real features (form, list, edit, bulk import) land in 1B/1C.

import React, { useEffect, useState } from "react";

const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_MONO = "'JetBrains Mono', 'Geist Mono', monospace";

// Theme tokens — mirrors App.jsx palette so the new view feels native.
const T = {
  card: "#13161b",
  cardElev: "#191d24",
  border: "#222831",
  borderSoft: "#1a1e25",
  text: "#ece8e0",
  textDim: "#8a8f99",
  gold: "#c9a961",
};

function authHeaders(auth) {
  const h = {};
  if (auth?.googleToken) h["x-google-token"] = auth.googleToken;
  if (auth?.password) h["x-app-password"] = auth.password;
  return h;
}

async function fetchTransactionsFromServer(auth) {
  const res = await fetch("/api/transactions", {
    headers: authHeaders(auth),
  });
  if (res.status === 401) {
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  if (res.status === 503) {
    const err = new Error("Storage not configured");
    err.code = 503;
    throw err;
  }
  if (!res.ok) {
    let msg = `Storage ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return await res.json();
}

// Exported for future chunks (1B will use save on every mutation).
// eslint-disable-next-line no-unused-vars
export async function saveTransactionsToServer(auth, transactions) {
  const res = await fetch("/api/transactions", {
    method: "PUT",
    headers: {
      ...authHeaders(auth),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ transactions }),
  });
  if (!res.ok) {
    let msg = `Save ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return await res.json();
}

export default function TransactionsView({ auth, onAuthFail }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [transactions, setTransactions] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTransactionsFromServer(auth)
      .then((data) => {
        if (cancelled) return;
        setTransactions(Array.isArray(data.transactions) ? data.transactions : []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.code === 401 && typeof onAuthFail === "function") {
          onAuthFail();
          return;
        }
        setError(err.message || "Failed to load");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth, onAuthFail]);

  if (loading) {
    return (
      <div
        style={{
          padding: "40px 0",
          textAlign: "center",
          color: T.textDim,
          fontFamily: FONT_MONO,
          fontSize: 12,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        Loading transactions…
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          background: T.card,
          border: `1px solid ${T.borderSoft}`,
          padding: 20,
          color: "#e57373",
          fontFamily: FONT_MONO,
          fontSize: 12,
        }}
      >
        Error: {error}
      </div>
    );
  }

  return (
    <div>
      <section
        style={{
          background: T.card,
          border: `1px solid ${T.borderSoft}`,
          padding: 24,
          marginBottom: 18,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.2em",
            color: T.gold,
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Transactions Log
        </div>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 20,
            fontStyle: "italic",
            marginBottom: 12,
          }}
        >
          {transactions.length === 0
            ? "No transactions yet"
            : `${transactions.length} transaction${transactions.length === 1 ? "" : "s"} stored`}
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: T.textDim,
            lineHeight: 1.6,
          }}
        >
          Add form, filters, edit and bulk import arrive in the next deploys.
          <br />
          Endpoint and storage are live — your data will persist from here on.
        </div>
      </section>
    </div>
  );
}
