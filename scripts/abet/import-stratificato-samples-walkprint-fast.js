import { runWalkprintImport } from "./_walkprint-image-import-common.js";

await runWalkprintImport({
  imageType: "sample",
  confirmToken: "STRATIFICATO_CARDS",
  cleanupGallery: false,
});
