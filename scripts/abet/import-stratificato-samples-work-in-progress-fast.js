import { runWorkInProgressImport } from "./_work-in-progress-image-import-common.js";

await runWorkInProgressImport({
  imageType: "sample",
  confirmToken: "STRATIFICATO_CARDS",
  cleanupGallery: false,
});
