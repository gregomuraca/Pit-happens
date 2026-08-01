// Server-side proxy to the Gemma orchestrator (FastAPI, :8420).
// This is the "Gemma inference and tool orchestration" call GEMMA_HANDOFF.md
// asked to live in a Route Handler — it runs on the Next.js server only.
// The actual tool-calling loop and the Spur API key live in the Python
// orchestrator (../orchestrator.py); this route just forwards to it so we
// don't duplicate that validated logic in a second language under a
// hackathon deadline.

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:8420";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const scenario = searchParams.get("scenario");
  const lap = searchParams.get("lap");

  if (!scenario || !lap) {
    return Response.json({ error: "scenario and lap query params are required" }, { status: 400 });
  }

  const res = await fetch(`${ORCHESTRATOR_URL}/api/scenario/${scenario}/lap/${lap}`, {
    cache: "no-store",
  });
  const data = await res.json();
  return Response.json(data, { status: res.status });
}
