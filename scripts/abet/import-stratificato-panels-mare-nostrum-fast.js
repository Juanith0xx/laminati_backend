import { runMareNostrumImport } from "./_mare-nostrum-image-import-common.js";

await runMareNostrumImport({
  imageType: "panel",
  confirmToken: "STRATIFICATO_PANELS",
  cleanupGallery: true,
});
