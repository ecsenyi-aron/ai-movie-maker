import "server-only";
import { getSupabaseServiceClient } from "./supabase/server";

export interface ReserveBudgetResult {
  ok: boolean;
  reason: string;
  remaining: number;
}

export interface BudgetSummary {
  budget_usd: number;
  spent_usd: number;
  open_reserved_usd: number;
  remaining_usd: number;
}

/**
 * Foglal budgetet egy generálási feladathoz az adatbázis atomi függvényével.
 */
export async function reserveBudget(
  projectId: string,
  jobId: string,
  amountUsd: number
): Promise<ReserveBudgetResult> {
  const supabase = getSupabaseServiceClient();
  const { data, error } = await (supabase.rpc as any)("reserve_budget", {
    p_project_id: projectId,
    p_job_id: jobId,
    p_amount_usd: amountUsd,
  });

  if (error) {
    throw new Error(`Hiba a reserve_budget hívásakor: ${error.message}`);
  }

  const result = Array.isArray(data) ? data[0] : data;
  return {
    ok: Boolean(result?.ok),
    reason: result?.reason ?? "Unknown reason",
    remaining: Number(result?.remaining ?? 0),
  };
}

/**
 * Lezárja (settle) a job költségét: felszabadítja a foglalást és rögzíti a tényleges költséget.
 * Visszatérési érték: 'settled', 'already_settled', vagy 'cap_exceeded'.
 */
export async function settleBudget(
  jobId: string,
  actualUsd: number
): Promise<string> {
  const supabase = getSupabaseServiceClient();
  const { data, error } = await (supabase.rpc as any)("settle_budget", {
    p_job_id: jobId,
    p_actual_usd: actualUsd,
  });

  if (error) {
    throw new Error(`Hiba a settle_budget hívásakor: ${error.message}`);
  }

  return typeof data === "string" ? data : (data ?? "settled");
}

/**
 * Felszabadít egy nyitott foglalást költség nélkül (sikertelen feladatok esetén).
 */
export async function releaseBudget(jobId: string): Promise<void> {
  const supabase = getSupabaseServiceClient();
  const { error } = await (supabase.rpc as any)("release_budget", {
    p_job_id: jobId,
  });

  if (error) {
    throw new Error(`Hiba a release_budget hívásakor: ${error.message}`);
  }
}

/**
 * Lekéri a projekt költségvetési összefoglalóját.
 */
export async function getProjectBudgetSummary(
  projectId: string
): Promise<BudgetSummary> {
  const supabase = getSupabaseServiceClient();
  const { data, error } = await (supabase.rpc as any)("project_budget_summary", {
    p_project_id: projectId,
  });

  if (error) {
    throw new Error(`Hiba a project_budget_summary hívásakor: ${error.message}`);
  }

  const result = Array.isArray(data) ? data[0] : data;
  return {
    budget_usd: Number(result?.budget_usd ?? 0),
    spent_usd: Number(result?.spent_usd ?? 0),
    open_reserved_usd: Number(result?.open_reserved_usd ?? 0),
    remaining_usd: Number(result?.remaining_usd ?? 0),
  };
}
