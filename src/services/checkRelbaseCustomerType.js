import "dotenv/config";

import {
  findRelbaseCustomerByRutService,
} from "./relbaseCustomer.service.js";

const RUT = "18.083.379-K";

const run = async () => {
  try {
    console.log(
      "Buscando cliente persona natural en Relbase..."
    );

    console.log(
      "RUT:",
      RUT
    );

    const result =
      await findRelbaseCustomerByRutService(
        RUT
      );

    if (
      !result?.found ||
      !result?.customer
    ) {
      console.log(
        "\n❌ No se encontró el cliente en Relbase."
      );

      process.exit(0);
    }

    const customer =
      result.customer;

    console.log(
      "\n✅ Cliente encontrado:\n"
    );

    console.log(
      JSON.stringify(
        {
          id:
            customer.id ??
            null,

          rut:
            customer.rut ??
            null,

          name:
            customer.name ??
            null,

          type_customer:
            customer.type_customer ??
            null,
        },
        null,
        2
      )
    );

    process.exit(0);
  } catch (error) {
    console.error(
      "\n❌ Error consultando Relbase:"
    );

    console.error({
      message:
        error?.message ??
        null,

      code:
        error?.code ??
        null,

      status:
        error?.status ??
        null,
    });

    process.exit(1);
  }
};

run();