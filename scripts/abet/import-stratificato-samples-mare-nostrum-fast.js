import { runMareNostrumImport } from "./_mare-nostrum-image-import-common.js";

await runMareNostrumImport({
  imageType: "sample",
  confirmToken: "STRATIFICATO_CARDS",
  cleanupGallery: false,
});
