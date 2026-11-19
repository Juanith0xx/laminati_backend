import { runNavalDeckImport } from "./_naval-deck-image-import-common.js";

await runNavalDeckImport({
  imageType: "panel",
  confirmToken: "STRATIFICATO_PANELS",
  cleanupGallery: true,
});
