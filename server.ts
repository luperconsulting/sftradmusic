import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Crucial middleware to handle JSON request bodies
  app.use(express.json());

  // Simple clean endpoint (not used by the form since it uses pure frontend mailto redirection)
  app.post("/api/book-lesson", (req, res) => {
    const { fullName } = req.body;
    return res.status(200).json({
      success: true,
      message: `Dear ${fullName || "Student"}, your inquiry has been logged.`
    });
  });

  // Setup Vite middleware for development context or serve compiled SPA for production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Stitch] Active server listening on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Critical server bootstrap failure:", error);
  process.exit(1);
});
