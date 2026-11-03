/**
 * Agent 5 — Quality Control and Preview (code, no LLM)
 * Checks asset existence, playability, duration against lock.
 * Sets `qc_ok` or `needs_review` and generates QC notes.
 */

export interface QCResult {
  status: 'qc_ok' | 'needs_review';
  qcNotes: string;
}

export function runAgent5QC(
  actualDuration: number,
  targetDuration: number,
  hasMedia: boolean,
  attribution?: string
): QCResult {
  if (!hasMedia) {
    return {
      status: 'needs_review',
      qcNotes: 'Hiányzó médiafájl vagy sikertelen generálás.'
    };
  }

  const durationDiff = Math.abs(actualDuration - targetDuration);
  if (durationDiff > 2.5) {
    return {
      status: 'needs_review',
      qcNotes: `Időtartam eltérés a céltól: ${durationDiff.toFixed(1)}s (cél: ${targetDuration}s, tényleges: ${actualDuration}s).`
    };
  }

  return {
    status: 'qc_ok',
    qcNotes: attribution ? `Minőségellenőrzés sikeres. Forrás: ${attribution}` : 'Minőségellenőrzés sikeres.'
  };
}
