import "dotenv/config";
import {
  relbaseRequest,
} from "./relbase.service.js";

const run = async () => {
  try {
    console.log(
      "Consultando sesión OAuth actual de Relbase..."
    );

    const result =
      await relbaseRequest(
        "/api/v2/me"
      );

    console.dir(
      result?.data || result,
      {
        depth: null,
      }
    );
  } catch (error) {
    console.error(
      "❌ Error:",
      error?.message
    );

    console.error(
      "Status:",
      error?.status ||
        error?.statusCode ||
        null
    );

    console.error(
      "Response:",
      error?.response?.data ||
        error?.data ||
        null
    );
  }
};

run();