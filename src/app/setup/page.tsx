import SetupCheck from "@/components/SetupCheck";

export default function SetupPage() {
  return (
    <div className="flex flex-1 justify-center px-6 py-12">
      <main className="flex w-full max-w-xl flex-col gap-6">
        <p className="text-sm uppercase tracking-wide text-zinc-500">
          Animatic / előnézet — 1. lépés
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          AI filmstúdió — beállítás
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Ez még nem a stúdió. Itt csak azt ellenőrizzük, hogy a saját Supabase
          projekted (adatbázis, névtelen belépés, RLS, storage) elérhető-e.
          Filmgenerálás nincs, és nincs hamis „sikeres készítés”.
        </p>
        <SetupCheck />
      </main>
    </div>
  );
}
