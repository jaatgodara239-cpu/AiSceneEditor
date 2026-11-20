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

app.use(express.json());
app.use(express.static("public"));
app.use("/outputs", express.static("/tmp/outputs"));

fs.mkdirSync("/tmp/uploads", { recursive: true });
fs.mkdirSync("/tmp/outputs", { recursive: true });

const jobs = new Map();
const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

const VIRAL_TEMPLATES = {
  song_beat_pulse: {
    id: "song_beat_pulse",
    templateName: "0. Song Beat Pulse + Waveform",
    layout: "song_hype_edit",
    topHookText: "BEAT DROP GOES CRAZY",
    bottomTagText: "TURN VOLUME UP",
    cutDurationSec: 0.75,
    contrastBoost: 1.14,
    saturationBoost: 1.24,
    beatSfx: ["impact", "pop", "whoosh", "tick"]
  },
  white_meme_hook: {
    id: "white_meme_hook",
    templateName: "1. White Top Banner Meme Hook",
    layout: "banner_top_white",
    topHookText: "BRO HAD ZERO BRAIN CELLS",
    bottomTagText: "WAIT FOR THE END...",
    cutDurationSec: 1.9,
    contrastBoost: 1.08,
    saturationBoost: 1.15,
    beatSfx: ["whoosh", "impact", "pop", "riser"]
  },
  dark_cinema_twist: {
    id: "dark_cinema_twist",
    templateName: "2. Dark Cinema Twist Reveal",
    layout: "banner_dark_cinema",
    topHookText: "NOBODY EXPECTED THIS ENDING",
    bottomTagText: "WATCH UNTIL THE LAST SECOND",
    cutDurationSec: 2.3,
    contrastBoost: 1.12,
    saturationBoost: 1.08,
    beatSfx: ["riser", "impact", "whoosh", "tick"]
  },
  split_zoom_detective: {
    id: "split_zoom_detective",
    templateName: "3. Split-Screen Zoom Detective",
    layout: "split_zoom_focus",
    topHookText: "99% MISS WHAT HAPPENS HERE",
    bottomTagText: "ZOOMED IN ON THE ACTION",
    cutDurationSec: 2.1,
    contrastBoost: 1.07,
    saturationBoost: 1.14,
    beatSfx: ["tick", "riser", "impact", "pop"]
  },
  full_punch_montage: {
    id: "full_punch_montage",
    templateName: "4. Full-Screen Rapid Punch Cuts",
    layout: "full_punch_cuts",
    topHookText: "NON-STOP CHAOS IN 20 SECONDS",
    bottomTagText: "BLINK AND YOU MISS IT",
    cutDurationSec: 1.4,
    contrastBoost: 1.1,
    saturationBoost: 1.2,
    beatSfx: ["pop", "whoosh", "impact", "pop"]
  },
  curiosity_gap_white: {
    id: "curiosity_gap_white",
    templateName: "5. Curiosity Gap Question Card",
    layout: "banner_top_white",
    topHookText: "HOW DID THIS EVEN HAPPEN?!",
    bottomTagText: "EXPLAIN THIS LOGIC",
    cutDurationSec: 2.2,
    contrastBoost: 1.06,
    saturationBoost: 1.12,
    beatSfx: ["whoosh", "tick", "riser", "impact"]
  },
  instant_regret_dark: {
    id: "instant_regret_dark",
    templateName: "6. Instant Regret Dark Frame",
    layout: "banner_dark_cinema",
    topHookText: "INSTANT REGRET IN 3... 2... 1...",
    bottomTagText: "IT WENT WRONG IMMEDIATELY",
    cutDurationSec: 1.8,
    contrastBoost: 1.14,
    saturationBoost: 1.1,
    beatSfx: ["tick", "tick", "riser", "impact"]
  },
  double_take_split: {
    id: "double_take_split",
    templateName: "7. Double-Take Split Reaction",
    layout: "split_zoom_focus",
    topHookText: "LOOK AT THE BACKGROUND",
    bottomTagText: "REPLAY THAT RIGHT NOW",
    cutDurationSec: 2.0,
    contrastBoost: 1.08,
    saturationBoost: 1.16,
    beatSfx: ["pop", "riser", "impact", "whoosh"]
  },
  high_stakes_countdown: {
    id: "high_stakes_countdown",
    templateName: "8. High-Stakes Tension Build",
    layout: "full_punch_cuts",
    topHookText: "ONE MISTAKE RUINS EVERYTHING",
    bottomTagText: "HOLD YOUR BREATH...",
    cutDurationSec: 2.4,
    contrastBoost: 1.12,
    saturationBoost: 1.06,
    beatSfx: ["riser", "tick", "riser", "impact"]
  },
  deadpan_fact_white: {
    id: "deadpan_fact_white",
    templateName: "9. Deadpan Observation Banner",
    layout: "banner_top_white",
    topHookText: "CONFIDENCE WITH ZERO PREPARATION",
    bottomTagText: "BOLD STRATEGY",
    cutDurationSec: 2.1,
    contrastBoost: 1.05,
    saturationBoost: 1.12,
    beatSfx: ["pop", "whoosh", "pop", "impact"]
  },
  midnight_mystery_dark: {
    id: "midnight_mystery_dark",
    templateName: "10. Late-Night Mystery Frame",
    layout: "banner_dark_cinema",
    topHookText: "SOMETHING IS OFF ABOUT THIS",
    bottomTagText: "SPOT THE DETAIL",
    cutDurationSec: 2.5,
    contrastBoost: 1.15,
    saturationBoost: 0.98,
    beatSfx: ["riser", "tick", "whoosh", "impact"]
  },
  hyper_cut_hype: {
    id: "hyper_cut_hype",
    templateName: "11. Hyper-Cut Hype Montage",
    layout: "full_punch_cuts",
    topHookText: "BEST MOMENTS BACK TO BACK",
    bottomTagText: "PURE ENERGY",
    cutDurationSec: 1.3,
    contrastBoost: 1.12,
    saturationBoost: 1.22,
    beatSfx: ["whoosh", "pop", "impact", "whoosh"]
  },
  plot_twist_split: {
    id: "plot_twist_split",
    templateName: "12. Plot Twist Split Frame",
    layout: "split_zoom_focus",
    topHookText: "THE PLOT TWIST NOBODY SAW",
    bottomTagText: "DID NOT SEE THAT COMING",
    cutDurationSec: 2.2,
    contrastBoost: 1.09,
    saturationBoost: 1.15,
    beatSfx: ["whoosh", "riser", "impact", "pop"]
  }
};

const TEMPLATE_LIST = Object.values(VIRAL_TEMPLATES);

function getAI() {
  if (!process.env.GEMINI_API_KEY) return null;
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { apiVersion: "v1beta" }
  });
}

async function runFFmpeg(args) {
  await execFileAsync("ffmpeg", ["-y", ...args]);
}

async function getMediaInfo(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "json",
    filePath
  ]);
  const parsed = JSON.parse(stdout || "{}");
  const duration = parseFloat(parsed?.format?.duration || "0");
  const streams = parsed?.streams || [];
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 3.0,
    hasAudio
  };
}

function generateLocalViralTemplate(niche = "") {
  const base = TEMPLATE_LIST[Math.floor(Math.random() * TEMPLATE_LIST.length)];
  const cleanNiche = String(niche || "").trim();
  if (!cleanNiche) return { ...base };

  const customHooks = [
    cleanNiche.toUpperCase().slice(0, 34),
    `WHY THIS ${cleanNiche.toUpperCase().slice(0, 20)} WENT VIRAL`,
    `WAIT FOR THE ${cleanNiche.toUpperCase().slice(0, 18)} TWIST`,
    base.topHookText
  ];

  return {
    ...base,
    templateName: `${base.templateName.replace(/^\d+\.\s*/, "")} (${cleanNiche.slice(0, 16)})`,
    topHookText: customHooks[Math.floor(Math.random() * customHooks.length)]
  };
}

async function ensureSynthesizedSfx(sfxDir) {
  fs.mkdirSync(sfxDir, { recursive: true });
  const specs = {
    whoosh: [
      "-f", "lavfi", "-t", "0.45", "-i", "anoisesrc=color=white:amplitude=0.35",
      "-af", "bandpass=f=450:width_type=q:w=1.2,afade=t=in:st=0:d=0.18,afade=t=out:st=0.18:d=0.27,volume=2.4",
      "-ar", "44100", "-ac", "2"
    ],
    impact: [
      "-f", "lavfi", "-t", "0.5", "-i", "sine=frequency=95:beep_factor=0.5",
      "-af", "lowpass=f=160,afade=t=in:st=0:d=0.01,afade=t=out:st=0.05:d=0.45,volume=2.2",
      "-ar", "44100", "-ac", "2"
    ],
    tick: [
      "-f", "lavfi", "-t", "0.12", "-i", "sine=frequency=1400",
      "-af", "highpass=f=800,afade=t=in:st=0:d=0.005,afade=t=out:st=0.01:d=0.11,volume=1.4",
      "-ar", "44100", "-ac", "2"
    ],
    riser: [
      "-f", "lavfi", "-t", "0.75", "-i", "anoisesrc=color=pink:amplitude=0.25",
      "-af", "highpass=f=250,afade=t=in:st=0:d=0.6,afade=t=out:st=0.62:d=0.13,volume=2.2",
      "-ar", "44100", "-ac", "2"
    ],
    pop: [
      "-f", "lavfi", "-t", "0.18", "-i", "sine=frequency=520",
      "-af", "afade=t=in:st=0:d=0.01,afade=t=out:st=0.02:d=0.16,volume=1.5",
      "-ar", "44100", "-ac", "2"
    ]
  };

  for (const [name, args] of Object.entries(specs)) {
    const outFile = path.join(sfxDir, `${name}.wav`);
    if (!fs.existsSync(outFile)) {
      await runFFmpeg([...args, outFile]);
    }
  }
}

function resolveSfxPath(sfxName, synthSfxDir) {
  if (!sfxName || sfxName === "none") return null;
  const safeName = path.basename(sfxName).replace(/[^a-zA-Z0-9_-]/g, "");
  for (const ext of [".mp3", ".wav", ".ogg"]) {
    const custom = path.join(process.cwd(), "sfx", `${safeName}${ext}`);
    if (fs.existsSync(custom)) return custom;
  }
  const synth = path.join(synthSfxDir, `${safeName}.wav`);
  return fs.existsSync(synth) ? synth : null;
}

function wrapBannerText(text, maxCharsPerLine = 24, maxLines = 2) {
  const words = String(text || "")
    .replace(/['":\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  const lines = [];
  let current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length <= maxCharsPerLine) {
      current = (current + " " + w).trim();
    } else {
      if (current) lines.push(current);
      current = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.join("\n");
    }
app.get("/api/templates", (req, res) => {
  res.json({ templates: TEMPLATE_LIST });
});

app.post("/api/invent-template", async (req, res) => {
  const { niche, clipCount } = req.body || {};
  const ai = getAI();

  if (ai) {
    try {
      const prompt = `
Design a viral YouTube Shorts editing template for:
Niche/Vibe: ${niche || "Song edit / funny / shocking moments"}
Clips: ${clipCount || 2}
Layout options: "song_hype_edit", "banner_top_white", "banner_dark_cinema", "split_zoom_focus", "full_punch_cuts".
SFX options: "whoosh", "impact", "tick", "riser", "pop".
Return ONLY valid JSON:
{
  "templateName": "Short catchy name",
  "layout": "song_hype_edit",
  "topHookText": "Punchy 4-7 word hook",
  "bottomTagText": "Short 2-4 word tag",
  "cutDurationSec": 0.8,
  "contrastBoost": 1.12,
  "saturationBoost": 1.2,
  "beatSfx": ["impact", "pop", "whoosh", "tick"]
}`;
      const result = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      return res.json({ template: JSON.parse(result.text), source: "ai" });
    } catch (err) {
      console.warn("AI quota/limit hit, using local template engine:", err.message);
    }
  }

  return res.json({ template: generateLocalViralTemplate(niche), source: "local_engine" });
});

async function renderSlicesToShort(workDir, synthSfxDir, slices, template, outFilePath, cropMarginPercent = 0) {
  const outW = 720;
  const outH = 1280;
  const allowedLayouts = new Set([
    "song_hype_edit",
    "banner_top_white",
    "banner_dark_cinema",
    "split_zoom_focus",
    "full_punch_cuts"
  ]);
  const layout = allowedLayouts.has(template.layout) ? template.layout : "banner_top_white";
  const contrast = Math.min(1.3, Math.max(0.95, Number(template.contrastBoost) || 1.1));
  const saturation = Math.min(1.4, Math.max(0.9, Number(template.saturationBoost) || 1.16));
  const topHook = wrapBannerText(template.topHookText || "WAIT FOR THE END", 24, 2);
  const bottomTag = wrapBannerText(template.bottomTagText || "", 28, 1);
  const beatSfxList =
    Array.isArray(template.beatSfx) && template.beatSfx.length
      ? template.beatSfx
      : ["whoosh", "impact", "pop", "riser"];

  const wmTrim = 1 + Math.min(0.25, Math.max(0, Number(cropMarginPercent) || 0)) / 100;
  const renderedSegments = [];

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    const sfxKey = beatSfxList[i % beatSfxList.length];
    const segOut = path.join(workDir, `beat_${path.basename(outFilePath, ".mp4")}_${i}.mp4`);
    const zoomDir = i % 2 === 0 ? 1 : -1;
    const padScale = 1.16 * wmTrim;

    // Glow / beat punch brightness pulse on alternating beats for song edits
    const beatPulse =
      layout === "song_hype_edit" && i % 2 === 0
        ? `:brightness=0.06`
        : "";
    const colorGrade = `eq=contrast=${contrast}:saturation=${saturation}${beatPulse}`;

    const startFrac = (i / slices.length).toFixed(4);
    const endFrac = ((i + 1) / slices.length).toFixed(4);
    const barExpr = `${outW}*(${startFrac}+(${endFrac}-${startFrac})*(t/${slice.duration.toFixed(3)}))`;
    const progressBar = `,drawbox=x=0:y=0:w='${barExpr}':h=10:color=#ef4444:t=fill`;

    const drawTopText = topHook
      ? `,drawtext=fontfile=${FONT_PATH}:text='${topHook}':fontcolor=${
          layout === "banner_top_white" ? "black" : "white"
        }:fontsize=40:line_spacing=8:x=(w-text_w)/2:y=${
          layout === "banner_top_white" ? "95" : "105"
        }`
      : "";
    const drawBottomText = bottomTag
      ? `,drawtext=fontfile=${FONT_PATH}:text='${bottomTag}':fontcolor=${
          layout === "banner_top_white" ? "black" : "#facc15"
        }:fontsize=32:x=(w-text_w)/2:y=h-120`
      : "";

    const ffInputs = ["-ss", slice.start.toFixed(2), "-t", slice.duration.toFixed(2), "-i", slice.srcPath];
    const audioFilters = [];
    const mixLabels = [];

    if (slice.hasAudio) {
      audioFilters.push(`[0:a]aresample=44100,volume=0.88[basea]`);
      mixLabels.push("[basea]");
    } else {
      ffInputs.push("-f", "lavfi", "-t", slice.duration.toFixed(2), "-i", "anullsrc=r=44100:cl=stereo");
      audioFilters.push(`[1:a]volume=0.0[basea]`);
      mixLabels.push("[basea]");
    }

    const sfxPath = resolveSfxPath(sfxKey, synthSfxDir);
    if (sfxPath && layout !== "song_hype_edit") {
      const sfxIdx = ffInputs.filter((x) => x === "-i").length;
      ffInputs.push("-i", sfxPath);
      audioFilters.push(`[${sfxIdx}:a]aresample=44100,volume=0.95[sfxa]`);
      mixLabels.push("[sfxa]");
    }

    audioFilters.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=1[outa]`);

    let vf = "";
    if (layout === "song_hype_edit") {
      // High-energy music edit: punchy zoom crop + glow/color pop + animated waveform bar
      const scaledW = Math.round(outW * padScale);
      const scaledH = Math.round(outH * padScale);
      const dx = scaledW - outW;
      const dy = scaledH - outH;
      const cropMotion =
        zoomDir === 1
          ? `crop=${outW}:${outH}:x='${dx}*(t/${slice.duration})':y='${dy}*(t/${slice.duration})'`
          : `crop=${outW}:${outH}:x='${dx}*(1-t/${slice.duration})':y='${dy}*(1-t/${slice.duration})'`;

      vf =
        `[0:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,${cropMotion},${colorGrade}[vid];` +
        `[outa]asplit=2[wa][ma];` +
        `[wa]showwaves=s=${outW - 80}x130:mode=cline:colors=#38bdf8|#f472b6:rate=30[wave];` +
        `[vid][wave]overlay=40:h-290,drawbox=x=24:y=65:w=${outW - 48}:h=135:color=black@0.72:t=fill${drawTopText}${drawBottomText}${progressBar},format=yuv420p[outv]`;

      await runFFmpeg([
        ...ffInputs,
        "-filter_complex", `${vf};${audioFilters.join(";")}`,
        "-map", "[outv]",
        "-map", "[ma]",
        "-r", "30",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-shortest",
        segOut
      ]);
      renderedSegments.push(segOut);
      continue;
    }

    if (layout === "banner_top_white" || layout === "banner_dark_cinema") {
      const isWhite = layout === "banner_top_white";
      const boxH = isWhite ? 820 : 840;
      const overlayY = isWhite ? 230 : 220;
      const bgColor = isWhite ? "white" : "0x0b0d12";
      const scaledW = Math.round(outW * padScale);
      const scaledH = Math.round(boxH * padScale);
      const dx = scaledW - outW;
      const dy = scaledH - boxH;
      const cropMotion =
        zoomDir === 1
          ? `crop=${outW}:${boxH}:x='${dx}*(t/${slice.duration})':y='${dy}*(t/${slice.duration})'`
          : `crop=${outW}:${boxH}:x='${dx}*(1-t/${slice.duration})':y='${dy}*(1-t/${slice.duration})'`;

      vf =
        `[0:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,${cropMotion},${colorGrade}[vid];` +
        `color=c=${bgColor}:s=${outW}x${outH}:d=${slice.duration}[bg];` +
        `[bg][vid]overlay=0:${overlayY}${drawTopText}${drawBottomText}${progressBar},format=yuv420p[outv]`;
    } else if (layout === "split_zoom_focus") {
      const halfH = outH / 2;
      vf =
        `[0:v]split=2[v1][v2];` +
        `[v1]scale=${Math.round(outW * wmTrim)}:${Math.round(halfH * wmTrim)}:force_original_aspect_ratio=increase,crop=${outW}:${halfH},${colorGrade}[top];` +
        `[v2]scale=${Math.round(outW * 1.48 * wmTrim)}:${Math.round(halfH * 1.48 * wmTrim)}:force_original_aspect_ratio=increase,crop=${outW}:${halfH},${colorGrade}[bot];` +
        `[top][bot]vstack=inputs=2,drawbox=x=24:y=65:w=${outW - 48}:h=130:color=black@0.75:t=fill${drawTopText}${drawBottomText}${progressBar},format=yuv420p[outv]`;
    } else {
      const scaledW = Math.round(outW * 1.15 * wmTrim);
      const scaledH = Math.round(outH * 1.15 * wmTrim);
      const dx = scaledW - outW;
      const dy = scaledH - outH;
      const cropMotion =
        zoomDir === 1
          ? `crop=${outW}:${outH}:x='${dx}*(t/${slice.duration})':y='${dy}*(t/${slice.duration})'`
          : `crop=${outW}:${outH}:x='${dx}*(1-t/${slice.duration})':y='${dy}*(1-t/${slice.duration})'`;

      vf =
        `[0:v]scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,${cropMotion},${colorGrade},` +
        `drawbox=x=24:y=65:w=${outW - 48}:h=135:color=black@0.72:t=fill${drawTopText}${drawBottomText}${progressBar},format=yuv420p[outv]`;
    }

    await runFFmpeg([
      ...ffInputs,
      "-filter_complex", `${vf};${audioFilters.join(";")}`,
      "-map", "[outv]",
      "-map", "[outa]",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest",
      segOut
    ]);

    renderedSegments.push(segOut);
  }

  const concatPath = path.join(workDir, `concat_${path.basename(outFilePath, ".mp4")}.txt`);
  fs.writeFileSync(concatPath, renderedSegments.map((p) => `file '${p}'`).join("\n"));

  await runFFmpeg([
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outFilePath
  ]);
}

async function processJob(jobId, clipFiles, template, options) {
  const workDir = `/tmp/job_${jobId}`;
  const synthSfxDir = path.join(workDir, "synth_sfx");
  fs.mkdirSync(workDir, { recursive: true });

  const update = (progress, status, extra = {}) => {
    jobs.set(jobId, { id: jobId, progress, status, ...extra });
  };

  try {
    update(10, "Preparing sound effects...");
    await ensureSynthesizedSfx(synthSfxDir);

    const cutSec = Math.min(4.5, Math.max(0.5, Number(template.cutDurationSec) || 2.0));
    const cropMargin = Number(options.cropMarginPercent) || 0;
    const autoExtractCount = Math.min(4, Math.max(1, Number(options.autoExtractCount) || 1));

    const firstInfo = await getMediaInfo(clipFiles[0].path);
    const isLongSingleVideo = clipFiles.length === 1 && firstInfo.duration > 75 && autoExtractCount > 1;
    const outputs = [];

    if (isLongSingleVideo) {
      const clipLen = 22;
      const usableSpan = Math.max(clipLen, firstInfo.duration - clipLen);

      for (let k = 0; k < autoExtractCount; k++) {
        const pct = 18 + Math.floor((k / autoExtractCount) * 75);
        update(pct, `Auto-clipping Short ${k + 1}/${autoExtractCount}...`);

        const windowStart = Math.floor((usableSpan / autoExtractCount) * k + usableSpan / (autoExtractCount * 4));
        const slices = [];
        let cursor = windowStart;
        const windowEnd = Math.min(firstInfo.duration, windowStart + clipLen);

        while (cursor + 0.45 < windowEnd) {
          const segDur = Math.min(cutSec, windowEnd - cursor);
          slices.push({
            srcPath: clipFiles[0].path,
            start: cursor,
            duration: segDur,
            hasAudio: firstInfo.hasAudio
          });
          cursor += segDur;
        }

        const outFilename = `short_${jobId}_part${k + 1}.mp4`;
        const finalPath = path.join("/tmp/outputs", outFilename);
        await renderSlicesToShort(workDir, synthSfxDir, slices, template, finalPath, cropMargin);
        outputs.push({ label: `Clip #${k + 1}`, url: `/outputs/${outFilename}` });
      }
    } else {
      update(25, "Slicing clips into viral beats...");
      const slices = [];
      let totalTargetSec = 0;
      const maxShortSec = 26;

      for (const clip of clipFiles) {
        if (totalTargetSec >= maxShortSec) break;
        const info = await getMediaInfo(clip.path);
        let cursor = 0;
        while (cursor + 0.45 < info.duration && totalTargetSec < maxShortSec) {
          const segDur = Math.min(cutSec, info.duration - cursor, maxShortSec - totalTargetSec);
          slices.push({
            srcPath: clip.path,
            start: cursor,
            duration: segDur,
            hasAudio: info.hasAudio
          });
          cursor += segDur;
          totalTargetSec += segDur;
        }
      }

      if (!slices.length) throw new Error("No playable video frames found.");

      update(55, "Rendering edited Short with SFX & hook banners...");
      const outFilename = `short_${jobId}.mp4`;
      const finalPath = path.join("/tmp/outputs", outFilename);
      await renderSlicesToShort(workDir, synthSfxDir, slices, template, finalPath, cropMargin);
      outputs.push({ label: "Edited Short", url: `/outputs/${outFilename}` });
    }

    update(100, "Done!", {
      done: true,
      downloadUrl: outputs[0].url,
      outputs
    });
  } catch (err) {
    console.error("Job failed:", err);
    update(0, `Error: ${err.message}`, { error: true });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    for (const f of clipFiles) fs.rmSync(f.path, { force: true });
  }
}

app.post("/api/render-short", upload.array("clips", 8), (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: "Upload at least 1 video clip." });
  }

  let template = {};
  try {
    template = JSON.parse(req.body.templateJson || "{}");
  } catch {
    return res.status(400).json({ error: "Invalid template JSON." });
  }

  const jobId = Date.now().toString(36);
  jobs.set(jobId, { id: jobId, progress: 3, status: "Queued..." });

  processJob(jobId, req.files, template, {
    cropMarginPercent: req.body.cropMarginPercent || 12,
    autoExtractCount: req.body.autoExtractCount || 3
  });

  res.json({ jobId });
});

app.get("/api/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shorts Studio (Song Edit + 12 Templates) running on ${PORT}`));
      
