"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { testGeminiKeyAction } from "@/app/setup/actions";

type CheckStatus = "idle" | "running" | "ok" | "fail";

type CheckRow = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
};

const INITIAL_CHECKS: CheckRow[] = [
  {
    id: "env",
    label: "Környezeti változók (.env.local)",
    status: "idle",
    detail: "Még nem futtatva",
  },
  {
    id: "anon",
    label: "Névtelen bejelentkezés",
    status: "idle",
    detail: "Még nem futtatva",
  },
  {
    id: "insert",
    label: "Saját tesztprojekt mentése (RLS)",
    status: "idle",
    detail: "Még nem futtatva",
  },
  {
    id: "read",
    label: "Saját projekt visszaolvasása (RLS)",
    status: "idle",
    detail: "Még nem futtatva",
  },
  {
    id: "storage",
    label: "Storage bucket (media)",
    status: "idle",
    detail: "Még nem futtatva",
  },
  {
    id: "gemini",
    label: "Gemini API kulcs és modell teszt (ingyenes)",
    status: "idle",
    detail: "Még nem futtatva",
  },
];

function statusLabel(status: CheckStatus): string {
  switch (status) {
    case "idle":
      return "vár";
    case "running":
      return "folyamatban";
    case "ok":
      return "siker";
    case "fail":
      return "hiba";
  }
}

export default function SetupCheck() {
  const [checks, setChecks] = useState<CheckRow[]>(INITIAL_CHECKS);
  const [running, setRunning] = useState(false);

  function update(id: string, status: CheckStatus, detail: string) {
    setChecks((prev) =>
      prev.map((row) => (row.id === id ? { ...row, status, detail } : row)),
    );
  }

  async function runChecks() {
    setRunning(true);
    setChecks(INITIAL_CHECKS.map((row) => ({ ...row, status: "idle" })));

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    update("env", "running", "Ellenőrzés…");
    if (!url || !anonKey) {
      update(
        "env",
        "fail",
        "Hiányzik a NEXT_PUBLIC_SUPABASE_URL vagy a NEXT_PUBLIC_SUPABASE_ANON_KEY. Töltsd ki a .env.local fájlt, majd indítsd újra a szervert.",
      );
      setRunning(false);
      return;
    }
    update("env", "ok", `URL be van állítva: ${url}`);

    let supabase;
    try {
      supabase = getSupabaseBrowserClient();
    } catch (error) {
      update(
        "anon",
        "fail",
        error instanceof Error ? error.message : "A kliens nem jött létre.",
      );
      setRunning(false);
      return;
    }

    update("anon", "running", "Bejelentkezés…");
    const { data: authData, error: authError } =
      await supabase.auth.signInAnonymously();

    if (authError || !authData.user) {
      update(
        "anon",
        "fail",
        authError?.message ??
          "A névtelen bejelentkezés nem adott vissza felhasználót. Kapcsold be az Anonymous Sign-In-t a Supabase Authentication oldalon.",
      );
      setRunning(false);
      return;
    }

    const userId = authData.user.id;
    update("anon", "ok", `Felhasználó azonosító: ${userId}`);

    update("insert", "running", "Tesztprojekt beszúrása…");
    const { data: inserted, error: insertError } = await supabase
      .from("projects")
      .insert({
        user_id: userId,
        title: "Beállítás teszt",
        premise: "Csak az 1. lépés adatbázis-ellenőrzése.",
        mode: "stock",
        budget_usd: 0,
        status: "draft",
      })
      .select("id, title, user_id")
      .single();

    if (insertError || !inserted) {
      update(
        "insert",
        "fail",
        insertError?.message ?? "A tesztprojekt nem jött létre.",
      );
      setRunning(false);
      return;
    }
    update("insert", "ok", `Projekt azonosító: ${inserted.id}`);

    update("read", "running", "Visszaolvasás…");
    const { data: readBack, error: readError } = await supabase
      .from("projects")
      .select("id, title")
      .eq("id", inserted.id)
      .single();

    if (readError || !readBack) {
      update(
        "read",
        "fail",
        readError?.message ?? "A saját projektet nem sikerült visszaolvasni.",
      );
      setRunning(false);
      return;
    }
    update("read", "ok", `Olvasva: ${readBack.title}`);

    update("storage", "running", "Bucket ellenőrzése…");
    const { error: storageError } = await supabase.storage
      .from("media")
      .list(userId, { limit: 1 });

    if (storageError) {
      update(
        "storage",
        "fail",
        storageError.message ||
          "A media bucket nem elérhető. Nézd meg a Storage oldalt a dashboardon.",
      );
      setRunning(false);
      return;
    }
    update(
      "storage",
      "ok",
      "A media bucket elérhető a saját mappához (lista lekérdezése sikerült).",
    );

    update("gemini", "running", "Gemini API hívás tesztelése…");
    const geminiRes = await testGeminiKeyAction();
    if (!geminiRes.success) {
      update("gemini", "fail", geminiRes.message);
      setRunning(false);
      return;
    }
    update("gemini", "ok", geminiRes.message);

    setRunning(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={runChecks}
        disabled={running}
        className="rounded-lg bg-zinc-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {running ? "Ellenőrzés folyamatban…" : "Kapcsolat ellenőrzése"}
      </button>

      <ul className="flex flex-col gap-3">
        {checks.map((row) => (
          <li
            key={row.id}
            className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <p className="text-sm font-medium">
              {row.label}{" "}
              <span className="text-zinc-500">({statusLabel(row.status)})</span>
            </p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {row.detail}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
