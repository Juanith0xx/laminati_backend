import { runWalkprintImport } from "./_walkprint-image-import-common.js";

await runWalkprintImport({
  imageType: "panel",
  confirmToken: "STRATIFICATO_PANELS",
  cleanupGallery: true,
});
