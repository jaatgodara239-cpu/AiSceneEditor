import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI } from "@google/genai";

const execFileAsync = promisify(execFile);
const app = express();
const upload = multer({ dest: "/tmp/uploads/" });

app.use(express.static("public"));
app.use("/outputs", express.static("/tmp/outputs"));

fs.mkdirSync("/tmp/uploads", { recursive: true });
fs.mkdirSync("/tmp/outputs", { recursive: true });

const jobs = new Map();

function getAI() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { apiVersion: "v1beta" }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label = "API call", maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[${label}] attempt ${attempt}/${maxAttempts}`);
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      const isTransient =
        msg.includes("503") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("429") ||
        msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("500") ||
        msg.includes("INTERNAL");
      if (!isTransient || attempt === maxAttempts) break;
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

// Extract base64 audio or image from Interactions API response (steps or legacy outputs)
function extractMedia(interaction, mediaType) {
  if (!interaction) return null;

  if (mediaType === "audio" && interaction.output_audio?.data) {
    return interaction.output_audio.data;
  }
  if (mediaType === "image" && interaction.output_image?.data) {
    return interaction.output_image.data;
  }

  if (Array.isArray(interaction.steps)) {
    for (let i = interaction.steps.length - 1; i >= 0; i--) {
      const step = interaction.steps[i];
      const items = Array.isArray(step?.content)
        ? step.content
        : Array.isArray(step?.outputs)
        ? step.outputs
        : [];
      for (const item of items) {
        if (item?.type === mediaType && item?.data) return item.data;
      }
    }
  }

  if (Array.isArray(interaction.outputs)) {
    const found = interaction.outputs.find((o) => o?.type === mediaType && o?.data);
    if (found) return found.data;
  }

  return null;
}

async function getAudioDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);
  const sec = parseFloat(stdout.trim());
  return Number.isFinite(sec) && sec > 0 ? sec : 3.0;
}

async function runFFmpeg(args) {
  await execFileAsync("ffmpeg", ["-y", ...args]);
}

function resolveSfxPath(sfxName) {
  if (!sfxName || sfxName === "none") return null;
  const safeName = path.basename(sfxName).replace(/[^a-zA-Z0-9_-]/g, "");
  for (const ext of [".mp3", ".wav", ".ogg"]) {
    const candidate = path.join(process.cwd(), "sfx", `${safeName}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function buildVideoJob(jobId, opts) {
  const workDir = `/tmp/job_${jobId}`;
  fs.mkdirSync(workDir, { recursive: true });

  const update = (progress, status, extra = {}) => {
    jobs.set(jobId, { id: jobId, progress, status, ...extra });
  };

  try {
    const ai = getAI();
    const isShort = opts.aspectRatio === "9:16";
    const width = isShort ? 720 : 1280;
    const height = isShort ? 1280 : 720;

    // 1. Storyboard via Gemini 3.8 Flash
    update(8, "Writing script & scene storyboard...");
    const storyboardPrompt = `
Create a short explainer storyboard for: ${opts.topic}
Break into ${opts.sceneCount} scenes (1 short sentence per scene, ~3-4s spoken).
Visual style: ${opts.visualStyle}.
${opts.hasReference ? "Keep the uploaded character reference consistent across all scenes." : ""}
SFX options: "whoosh", "impact", "tick", "riser", "none".

Return ONLY valid JSON:
{
  "title": "Short title",
  "voiceStyle": "engaging storyteller, steady pace",
  "musicPrompt": "subtle instrumental background music",
  "scenes": [
    {
      "narration": "Spoken line.",
      "imagePrompt": "Visual scene description, no text in image.",
      "sfx": "none"
    }
  ]
}
`;

    const scriptRes = await withRetry(
      () =>
        ai.models.generateContent({
          model: "gemini-3.8-flash",
          contents: storyboardPrompt,
          config: { responseMimeType: "application/json" }
        }),
      "Storyboard"
    );

    const storyboard = JSON.parse(scriptRes.text);
    const scenes = (storyboard.scenes || []).slice(0, opts.sceneCount);
    if (!scenes.length) throw new Error("No scenes generated.");

    // 2. Optional Background Music via Lyria 3.5 (non-blocking if unavailable)
    update(15, "Checking background music...");
    let bgmPath = null;
    try {
      const musicInteraction = await withRetry(
        () =>
          ai.interactions.create({
            model: "lyria-3.5",
            input: `Instrumental only, no vocals: ${storyboard.musicPrompt || "calm ambient underscore"}`
          }),
        "Lyria BGM",
        2
      );
      const musicAudio = extractMedia(musicInteraction, "audio");
      if (musicAudio) {
        bgmPath = path.join(workDir, "bgm.mp3");
        fs.writeFileSync(bgmPath, Buffer.from(musicAudio, "base64"));
      }
    } catch (e) {
      console.warn("Skipping BGM:", e.message);
    }

    let refImageBase64 = null;
    let refImageMime = null;
    if (opts.refImagePath) {
      refImageBase64 = fs.readFileSync(opts.refImagePath).toString("base64");
      refImageMime = opts.refImageMime || "image/png";
    }

    const segmentPaths = [];
    let cumulativeSec = 0;

    // 3. Per-scene TTS + Image + Fast Motion Video
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const stepBase = 20 + Math.floor((i / scenes.length) * 65);

      update(stepBase, `Scene ${i + 1}/${scenes.length}: Generating voiceover...`);
      const ttsInteraction = await withRetry(
        () =>
          ai.interactions.create({
            model: "gemini-3.8-flash-tts",
            input: [
              {
                type: "user_input",
                content: [
                  {
                    type: "text",
                    text: scene.narration,
                    annotations: [
                      {
                        type: "speech_metadata",
                        style: storyboard.voiceStyle || "engaging storyteller"
                      }
                    ]
                  }
                ]
              }
            ],
            response_format: { type: "audio" },
            generation_config: {
              speech_config: [{ voice: opts.voice || "Puck" }]
            }
          }),
        `TTS ${i + 1}`
      );

      const audioBase64 = extractMedia(ttsInteraction, "audio");
      if (!audioBase64) throw new Error(`No audio returned for scene ${i + 1}`);
      const wavPath = path.join(workDir, `voice_${i}.wav`);
      fs.writeFileSync(wavPath, Buffer.from(audioBase64, "base64"));
      const durationSec = await getAudioDuration(wavPath);

      update(stepBase + 4, `Scene ${i + 1}/${scenes.length}: Generating frame...`);
      const imgInput = [
        {
          type: "text",
          text: `${scene.imagePrompt}. Style: ${opts.visualStyle}. No text or captions in image.`
        }
      ];
      if (refImageBase64) {
        imgInput.push({ type: "image", data: refImageBase64, mime_type: refImageMime });
      }

      const imgInteraction = await withRetry(
        () =>
          ai.interactions.create({
            model: "gemini-nano-banana-2.1",
            input: imgInput,
            response_format: {
              type: "image",
              aspect_ratio: opts.aspectRatio,
              image_size: "1K"
            }
          }),
        `Image ${i + 1}`
      );

      const imgBase64 = extractMedia(imgInteraction, "image");
      if (!imgBase64) throw new Error(`No image returned for scene ${i + 1}`);
      const imgPath = path.join(workDir, `frame_${i}.png`);
      fs.writeFileSync(imgPath, Buffer.from(imgBase64, "base64"));

      // Mix audio (voice + optional SFX + optional BGM)
      update(stepBase + 7, `Scene ${i + 1}/${scenes.length}: Rendering clip...`);
      const mixedAudioPath = path.join(workDir, `mix_${i}.wav`);
      const sfxFile = resolveSfxPath(scene.sfx);
      const inputs = ["-i", wavPath];
      const filters = ["[0:a]volume=1.0[voice]"];
      const labels = ["[voice]"];

      if (sfxFile) {
        inputs.push("-i", sfxFile);
        filters.push(`[${inputs.length / 2 - 1}:a]volume=0.65[sfx]`);
        labels.push("[sfx]");
      }
      if (bgmPath) {
        inputs.push("-stream_loop", "-1", "-ss", cumulativeSec.toFixed(2), "-t", durationSec.toFixed(2), "-i", bgmPath);
        filters.push(`[${inputs.length / 2 - 1}:a]volume=0.20[bgm]`);
        labels.push("[bgm]");
      }
      filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=first[outa]`);

      await runFFmpeg([
        ...inputs,
        "-filter_complex", filters.join(";"),
        "-map", "[outa]",
        "-ar", "24000",
        "-ac", "1",
        mixedAudioPath
      ]);
      cumulativeSec += durationSec;

      // Fast, low-CPU Ken Burns crop motion
      const segPath = path.join(workDir, `seg_${i}.mp4`);
      const padW = Math.round(width * 1.12);
      const padH = Math.round(height * 1.12);
      const dx = padW - width;
      const dy = padH - height;
      const cropFilter =
        i % 2 === 0
          ? `crop=${width}:${height}:x='${dx}*(t/${Math.max(durationSec, 1)})':y='${dy}*(t/${Math.max(durationSec, 1)})'`
          : `crop=${width}:${height}:x='${dx}*(1-t/${Math.max(durationSec, 1)})':y='${dy}*(1-t/${Math.max(durationSec, 1)})'`;

      await runFFmpeg([
        "-loop", "1",
        "-i", imgPath,
        "-i", mixedAudioPath,
        "-vf", `scale=${padW}:${padH}:force_original_aspect_ratio=increase,${cropFilter},format=yuv420p`,
        "-r", "24",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "24",
        "-c:a", "aac",
        "-b:a", "128k",
        "-shortest",
        segPath
      ]);

      segmentPaths.push(segPath);
    }

    // 4. Concatenate segments
    update(92, "Stitching final MP4...");
    const concatListPath = path.join(workDir, "concat.txt");
    fs.writeFileSync(concatListPath, segmentPaths.map((p) => `file '${p}'`).join("\n"));

    const outFilename = `video_${jobId}.mp4`;
    const finalOutPath = path.join("/tmp/outputs", outFilename);

    await runFFmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      finalOutPath
    ]);

    update(100, "Done!", {
      done: true,
      downloadUrl: `/outputs/${outFilename}`,
      title: storyboard.title
    });
  } catch (err) {
    console.error("Job failed:", err);
    update(0, `Error: ${err.message}`, { error: true });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    if (opts.refImagePath) fs.rmSync(opts.refImagePath, { force: true });
  }
}

app.post("/api/generate", upload.single("characterRef"), (req, res) => {
  const jobId = Date.now().toString(36);
  const { topic, aspectRatio, sceneCount, visualStyle, voice } = req.body;

  if (!topic || !topic.trim()) {
    return res.status(400).json({ error: "Please enter a topic or script." });
  }

  jobs.set(jobId, { id: jobId, progress: 2, status: "Starting job..." });

  buildVideoJob(jobId, {
    topic: topic.trim(),
    aspectRatio: aspectRatio || "9:16",
    sceneCount: Math.min(20, Math.max(3, parseInt(sceneCount, 10) || 5)),
    visualStyle:
      visualStyle ||
      "Minimalist 2D stick-figure illustration with bold black ink lines, clean off-white background",
    voice: voice || "Puck",
    hasReference: Boolean(req.file),
    refImagePath: req.file?.path,
    refImageMime: req.file?.mimetype
  });

  res.json({ jobId });
});

app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
              
