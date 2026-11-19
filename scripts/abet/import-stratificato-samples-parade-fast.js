import { runParadeImport } from "./_parade-image-import-common.js";

await runParadeImport({
  imageType: "sample",
  confirmToken: "STRATIFICATO_CARDS",
  cleanupGallery: false,
});
