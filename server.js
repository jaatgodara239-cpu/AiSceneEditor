import express from "express";
import { EdgeTTS } from "edge-tts-universal";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

function splitScriptIntoChunks(text, maxLen = 1400) {
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

app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice = "en-US-AndrewNeural", rate = "+0%", pitch = "+0Hz" } = req.body || {};
    const cleanText = String(text || "").trim();
    if (!cleanText) {
      return res.status(400).json({ error: "Script text is required." });
    }

    const chunks = splitScriptIntoChunks(cleanText, 1400);
    const audioBuffers = [];

    for (const chunk of chunks) {
      const tts = new EdgeTTS(chunk, voice, { rate, pitch });
      const result = await tts.synthesize();
      const buf = Buffer.from(await result.audio.arrayBuffer());
      audioBuffers.push(buf);
    }

    const finalMp3 = Buffer.concat(audioBuffers);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", finalMp3.length);
    res.send(finalMp3);
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).json({ error: "Neural voice generation failed: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Coded 16:9 Animation Studio running on ${PORT}`));
