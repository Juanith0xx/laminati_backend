import { runWhimsyImport } from "./_whimsy-image-import-common.js";

await runWhimsyImport({
  imageType: "panel",
  confirmToken: "STRATIFICATO_PANELS",
  cleanupGallery: true,
});
