import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const EMAIL_BRAND_LOGO_CID =
  "laminati-world-logo";

export const EMAIL_BRAND_LOGO_PATH =
  path.resolve(
    __dirname,
    "../assets/email/logo-laminati-world.png"
  );

export const createEmailBrandLogoAttachment = () => ({
  filename: "logo-laminati-world.png",
  path: EMAIL_BRAND_LOGO_PATH,
  contentType: "image/png",
  cid: EMAIL_BRAND_LOGO_CID,
  contentDisposition: "inline",
});

export const renderEmailBrandLogo = ({
  width = 190,
} = {}) => {
  const safeWidth = Math.max(120, Math.min(Number(width) || 190, 260));

  return `<img
    src="cid:${EMAIL_BRAND_LOGO_CID}"
    alt="Laminati World"
    width="${safeWidth}"
    style="display:block;width:${safeWidth}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;"
  />`;
};
