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

    // 1. Storyboard + BGM prompt + SFX cues
    update(8, "Writing script, music prompt & scene cues...");
    const storyboardPrompt = `
You are a viral explainer video director. Create a storyboard for the topic/script below.
Break it into ${opts.sceneCount} visual beats (each beat = 1-2 short sentences, ~3-5 seconds spoken).
Visual style: ${opts.visualStyle}.
${opts.hasReference ? "A character reference image is provided. Keep this exact character consistent across all imagePrompts." : ""}
Available SFX keys (pick one or "none"): "whoosh", "impact", "tick", "riser", "none".

Return ONLY valid JSON (no markdown fences):
{
  "title": "Video title",
  "voiceStyle": "Narrator style instruction, e.g. 'tense documentary storyteller, steady pace'",
  "musicPrompt": "Instrumental background music description matching mood, no vocals",
  "scenes": [
    {
      "narration": "Exact spoken line for this beat.",
      "imagePrompt": "Scene visual prompt, no text or subtitles inside the image.",
      "sfx": "whoosh"
    }
  ]
}

Topic or Script:
${opts.topic}
`;

    const scriptRes = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: storyboardPrompt,
      config: { responseMimeType: "application/json" }
    });

    const storyboard = JSON.parse(scriptRes.text);
    const scenes = storyboard.scenes || [];
    if (!scenes.length) throw new Error("Failed to generate scenes.");

    // 2. Generate Instrumental Background Music via Lyria 3.5
    update(15, "Composing background music track...");
    let bgmPath = null;
    try {
      const musicInteraction = await ai.interactions.create({
        model: "lyria-3.5",
        input: `Instrumental only, no vocals, subtle background score: ${storyboard.musicPrompt || "ambient tension underscore"}`
      });
      const musicAudio = musicInteraction.output_audio?.data;
      if (musicAudio) {
        bgmPath = path.join(workDir, "bgm.mp3");
        fs.writeFileSync(bgmPath, Buffer.from(musicAudio, "base64"));
      }
    } catch (musicErr) {
      console.warn("BGM generation skipped:", musicErr.message);
    }

    let refImageBase64 = null;
    let refImageMime = null;
    if (opts.refImagePath) {
      refImageBase64 = fs.readFileSync(opts.refImagePath).toString("base64");
      refImageMime = opts.refImageMime || "image/png";
    }

    const segmentPaths = [];
    let cumulativeSec = 0;

    // 3. Generate Narration + Scene Art + Mixed Audio per Scene
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const stepBase = 20 + Math.floor((i / scenes.length) * 65);

      // 3A. Narration TTS
      update(stepBase, `Scene ${i + 1}/${scenes.length}: Voiceover...`);
      const ttsInteraction = await ai.interactions.create({
        model: "gemini-3.8-flash-tts",
        input: [{ type: "user_input", content: [{ type: "text", text: scene.narration }] }],
        generation_config: {
          speech_config: [{ voice: opts.voice || "Puck" }],
          speech_metadata: { style: storyboard.voiceStyle || "engaging storyteller" }
        }
      });

      const wavPath = path.join(workDir, `voice_${i}.wav`);
      const audioData = ttsInteraction.output_audio?.data;
      if (!audioData) throw new Error(`TTS failed on scene ${i + 1}`);
      fs.writeFileSync(wavPath, Buffer.from(audioData, "base64"));

      const durationSec = await getAudioDuration(wavPath);

      // 3B. Static Scene Image
      update(stepBase + 3, `Scene ${i + 1}/${scenes.length}: Scene frame...`);
      const imgInput = [
        {
          type: "text",
          text: `${scene.imagePrompt}. Style: ${opts.visualStyle}. Aspect ratio ${opts.aspectRatio}. No text or subtitles in image.`
        }
      ];
      if (refImageBase64) {
        imgInput.push({ type: "image", data: refImageBase64, mime_type: refImageMime });
      }

      const imgInteraction = await ai.interactions.create({
        model: "gemini-3.1-flash-image",
        input: imgInput,
        response_modalities: ["image"]
      });

      const imgOutput = (imgInteraction.outputs || []).find((o) => o.type === "image");
      if (!imgOutput?.data) throw new Error(`Image failed on scene ${i + 1}`);

      const imgPath = path.join(workDir, `frame_${i}.png`);
      fs.writeFileSync(imgPath, Buffer.from(imgOutput.data, "base64"));

      // 3C. Mix Narration + Optional Scene SFX + Sliced BGM Window
      update(stepBase + 6, `Scene ${i + 1}/${scenes.length}: Mixing audio & motion...`);
      const mixedAudioPath = path.join(workDir, `mix_${i}.wav`);
      const sfxFile = resolveSfxPath(scene.sfx);

      const inputs = ["-i", wavPath];
      const filterParts = ["[0:a]volume=1.0[voice]"];
      const mixInputs = ["[voice]"];

      if (sfxFile) {
        inputs.push("-i", sfxFile);
        filterParts.push(`[${inputs.length / 2 - 1}:a]volume=0.65[sfx]`);
        mixInputs.push("[sfx]");
      }

      if (bgmPath) {
        // Loop BGM seamlessly and slice the exact window for this scene
        inputs.push("-stream_loop", "-1", "-ss", cumulativeSec.toFixed(2), "-t", durationSec.toFixed(2), "-i", bgmPath);
        const bgmIdx = inputs.length / 2 - 1;
        filterParts.push(`[${bgmIdx}:a]volume=0.20[bgm]`);
        mixInputs.push("[bgm]");
      }

      filterParts.push(`${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=2[outa]`);

      await runFFmpeg([
        ...inputs,
        "-filter_complex", filterParts.join(";"),
        "-map", "[outa]",
        "-ar", "24000",
        "-ac", "1",
        mixedAudioPath
      ]);

      cumulativeSec += durationSec;

      // 3D. Render Segment Video
      const segPath = path.join(workDir, `seg_${i}.mp4`);
      const fps = 24;
      const totalFrames = Math.max(24, Math.ceil(durationSec * fps));
      const zoomExpr =
        i % 2 === 0
          ? `min(zoom+0.0012,1.15)`
          : `if(lte(zoom,1.0),1.15,max(1.001,zoom-0.0012))`;

      const vf = [
        `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
        `crop=${width * 2}:${height * 2}`,
        `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`,
        `format=yuv420p`
      ].join(",");

      await runFFmpeg([
        "-loop", "1",
        "-i", imgPath,
        "-i", mixedAudioPath,
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-shortest",
        segPath
      ]);

      segmentPaths.push(segPath);
    }

    // 4. Final Concatenate
    update(90, "Stitching final video...");
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
    sceneCount: Math.min(20, Math.max(3, parseInt(sceneCount, 10) || 6)),
    visualStyle:
      visualStyle ||
      "Minimalist 2D stick-figure illustration with bold black ink lines, clean off-white background, subtle shading",
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
    
