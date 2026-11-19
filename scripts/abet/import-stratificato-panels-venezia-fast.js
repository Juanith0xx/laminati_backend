import { runVeneziaImport } from "./_venezia-image-import-common.js";

await runVeneziaImport({
  imageType: "panel",
  confirmToken: "STRATIFICATO_PANELS",
  cleanupGallery: true,
});
