import { runNavalDeckImport } from "./_naval-deck-image-import-common.js";

await runNavalDeckImport({
  imageType: "sample",
  confirmToken: "STRATIFICATO_CARDS",
  cleanupGallery: false,
});
