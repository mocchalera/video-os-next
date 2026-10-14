import { defineConfig } from "cf/config";

// Sweet Lesson — 入れる部屋. Static assets only (dist/ from build.mjs, see wrangler.config.ts); no Worker code.
export default defineConfig({
  worker: {
    "name": "sweet-lesson",
    "compatibilityDate": "2026-10-01",
    "domains": ["sweet-lesson.mocchalera.app"],
    "workersDev": false,
    "previewUrls": false,
    "observability": { "enabled": false }
  }
});
