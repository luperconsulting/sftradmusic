import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createApp, defaultDeps } from "./server/app.js";

const PORTAL_ROUTE = /^\/(signin|signup|invite|verify|denied|reset-password|portal|teacher)(\/|$|\?)/;

async function startServer() {
  const app = express();
  const PORT = 3000;

  // The portal API has its own JSON parsing and error handling
  const portalApi = createApp(defaultDeps());
  app.use((req, res, next) => (req.path.startsWith("/api/") && req.path !== "/api/book-lesson" ? portalApi(req, res, next) : next()));

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
    // Portal routes load portal.html, the same way the rewrites in vercel.json do in production
    app.use((req, _res, next) => {
      if (PORTAL_ROUTE.test(req.path)) req.url = "/portal.html";
      next();
    });
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get(PORTAL_ROUTE, (_req, res) => {
      res.sendFile(path.join(distPath, "portal.html"));
    });
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
