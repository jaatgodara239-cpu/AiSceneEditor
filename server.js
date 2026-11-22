app.get("/api/clips", async (req, res) => {
  try {
    const q = String(req.query.q || "funny").trim() || "funny";
    const apiKey = process.env.PEXELS_API_KEY;

    if (!apiKey) {
      return res.status(400).json({
        error: "Add PEXELS_API_KEY in Render Environment Variables to search clips inside the app, or use Upload Funny Clip."
      });
    }

    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=10`;
    const response = await fetch(url, {
      headers: { Authorization: apiKey }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Clip search failed (" + response.status + ")." });
    }

    const data = await response.json();
    const clips = (data.videos || []).map((v) => {
      const files = Array.isArray(v.video_files) ? v.video_files : [];
      const chosen =
        files.find((f) => f.quality === "sd" && f.link) ||
        files.find((f) => f.link) ||
        {};
      return {
        id: v.id,
        duration: v.duration || 6,
        thumb: v.image || "",
        videoUrl: chosen.link || "",
        author: v.user?.name || "Pexels"
      };
    }).filter((c) => c.videoUrl);

    return res.json({ clips });
  } catch (err) {
    console.error("Clip search error:", err.message);
    return res.status(500).json({ error: "Could not load clips: " + err.message });
  }
});
