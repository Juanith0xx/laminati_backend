import { runWorkInProgressImport } from "./_work-in-progress-image-import-common.js";

await runWorkInProgressImport({
  imageType: "panel",
  confirmToken: "STRATIFICATO_PANELS",
  cleanupGallery: true,
});
