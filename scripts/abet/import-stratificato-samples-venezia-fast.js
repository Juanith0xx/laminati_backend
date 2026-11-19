import { runVeneziaImport } from "./_venezia-image-import-common.js";

await runVeneziaImport({
  imageType: "sample",
  confirmToken: "STRATIFICATO_CARDS",
  cleanupGallery: false,
});
