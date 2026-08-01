// Server-side ElevenLabs TTS call — the API key never reaches the browser,
// same pattern as the Spur/Gemma proxy in app/api/decide/route.ts.

const VOICE_ID = "yl2ZDV1MzN4HbQJbMihG";

export async function POST(request: Request) {
  const { text } = await request.json();
  if (!text || typeof text !== "string") {
    return Response.json({ error: "text is required" }, { status: 400 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "ELEVENLABS_API_KEY not configured" }, { status: 500 });
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return Response.json({ error: "ElevenLabs request failed", detail }, { status: res.status });
  }

  return new Response(res.body, {
    headers: { "Content-Type": "audio/mpeg" },
  });
}
