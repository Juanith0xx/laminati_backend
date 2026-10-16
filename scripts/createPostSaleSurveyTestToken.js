import "dotenv/config";

import {
  createOrRotateTestSurveyInvitation,
} from "../src/services/postSaleSurvey.service.js";


const orderId =
  process.argv[2] ||
  null;


try {
  const result =
    await createOrRotateTestSurveyInvitation(
      orderId
    );

  const frontendBaseUrl =
    String(
      process.env
        .FRONTEND_URL ||
        "http://localhost:3000"
    ).replace(
      /\/+$/,
      ""
    );

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    " ENCUESTA POSTVENTA · TOKEN DE PRUEBA"
  );
  console.log(
    "========================================"
  );
  console.log(
    "Orden:",
    result.order
      .order_number
  );
  console.log(
    "Cliente:",
    result.order
      .customer_name
  );
  console.log(
    "Expira:",
    result.invitation
      .expires_at
  );
  console.log("");
  console.log(
    "TOKEN:"
  );
  console.log(
    result.token
  );
  console.log("");
  console.log(
    "URL FUTURA DEL FRONTEND:"
  );
  console.log(
    `${frontendBaseUrl}/encuesta/${result.token}`
  );
  console.log("");
  console.log(
    "API GET:"
  );
  console.log(
    `${process.env.API_URL || "http://localhost:3001"}/api/public/post-sale-surveys/${result.token}`
  );
  console.log(
    "========================================"
  );
  console.log("");
} catch (error) {
  console.error(
    "No fue posible crear la encuesta de prueba:",
    error
  );

  process.exitCode =
    1;
}
