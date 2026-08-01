// Server-side proxy to the Gemma orchestrator (FastAPI, :8420).
// Runs on the Next.js server, never in the browser — no key exposure.

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:8420";

export async function GET() {
  const res = await fetch(`${ORCHESTRATOR_URL}/api/scenarios`, { cache: "no-store" });
  const data = await res.json();
  return Response.json(data, { status: res.status });
}
