import type { NextConfig } from "next";

// FastAPI (the Gemma orchestrator) runs separately on :8420 during dev.
// Route Handlers under app/api/* call it server-side — the browser
// never talks to it directly and never sees the Spur API key.
const nextConfig: NextConfig = {};

export default nextConfig;
