// Vercel entry point. vercel.json rewrites /api/* here, and Express routes on the original path.
import { createApp, defaultDeps } from "../server/app.js";

export default createApp(defaultDeps());
