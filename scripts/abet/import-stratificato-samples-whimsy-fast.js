import { runWhimsyImport } from "./_whimsy-image-import-common.js";

await runWhimsyImport({
  imageType: "sample",
  confirmToken: "STRATIFICATO_CARDS",
  cleanupGallery: false,
});
