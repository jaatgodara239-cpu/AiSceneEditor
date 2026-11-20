import express from "express";
import { EdgeTTS } from "edge-tts-universal";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

function splitScriptIntoChunks(text, maxLen = 700) {
  const sentences = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];

  const chunks = [];
  let current = "";

  for (const s of sentences) {
    if ((current + " " + s).trim().length <= maxLen) {
      current = (current + " " + s).trim();
    } else {
      if (current) chunks.push(current);
      current = s.trim();
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function withTimeout(promise, ms = 12000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("TTS request timed out")), ms))
  ]);
}
app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice = "en-US-AndrewNeural", rate = "+0%", pitch = "+0Hz" } = req.body || {};
    const cleanText = String(text || "").trim();
    if (!cleanText) {
      return res.status(400).json({ error: "Script text is required." });
    }

    const chunks = splitScriptIntoChunks(cleanText, 700);
    const audioBuffers = [];

    for (const chunk of chunks) {
      const tts = new EdgeTTS(chunk, voice, { rate, pitch });
      const result = await withTimeout(tts.synthesize(), 12000);
      if (result && result.audio) {
        const buf = Buffer.from(await result.audio.arrayBuffer());
        if (buf.length > 0) audioBuffers.push(buf);
      }
    }

    if (!audioBuffers.length) {
      return res.status(502).json({ error: "No audio returned from voice service." });
    }

    const finalMp3 = Buffer.concat(audioBuffers);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", finalMp3.length);
    return res.send(finalMp3);
  } catch (err) {
    console.error("TTS error:", err.message);
    return res.status(504).json({
      error: "Voice server blocked or timed out (" + err.message + "). Try 'Sync Scenes Only' or upload an audio file."
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Coded 16:9 Animation Studio running on ${PORT}`));
