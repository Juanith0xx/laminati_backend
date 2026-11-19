import { runParadeImport } from "./_parade-image-import-common.js";

await runParadeImport({
  imageType: "panel",
  confirmToken: "STRATIFICATO_PANELS",
  cleanupGallery: true,
});
