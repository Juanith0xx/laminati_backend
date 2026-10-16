import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";

import {
  deleteProductImageVariants,
  getProductImageSignedUrl,
  uploadProductImage,
} from "../src/services/productImageStorage.service.js";

/* =========================================
   ARGUMENTOS
========================================= */

const inputPath =
  process.argv[2];

if (!inputPath) {
  console.error("");
  console.error(
    "Debes indicar la ruta de una imagen."
  );

  console.error("");
  console.error(
    'Ejemplo: node .\\scripts\\test-product-image.js "C:\\Users\\Juan Estay\\Downloads\\imagen.jpg"'
  );

  process.exit(1);
}

/* =========================================
   TEST
========================================= */

const run = async () => {
  let uploadedKeys = [];

  try {
    const resolvedPath =
      path.resolve(inputPath);

    console.log("");
    console.log(
      "========================================="
    );
    console.log(
      "TEST OPTIMIZACIÓN PRODUCT IMAGE"
    );
    console.log(
      "========================================="
    );

    console.log("");
    console.log(
      "Archivo:"
    );
    console.log(
      resolvedPath
    );

    /* =====================================
       LEER ORIGINAL
    ===================================== */

    const buffer =
      await fs.readFile(
        resolvedPath
      );

    console.log("");
    console.log(
      `Original: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`
    );

    /* =====================================
       PROCESAR + SUBIR
    ===================================== */

    console.log("");
    console.log(
      "Procesando con Sharp y subiendo..."
    );

    const result =
      await uploadProductImage({
        buffer,

        sku: "1678M",

        imageType:
          "sample-test",
      });

    uploadedKeys =
      Object.values(
        result.variants
      ).map(
        (variant) =>
          variant.key
      );

    console.log("");
    console.log(
      "✅ Imagen procesada"
    );

    console.log("");
    console.log(
      "Fuente:"
    );

    console.log(
      result.source
    );

    /* =====================================
       MOSTRAR VARIANTES
    ===================================== */

    for (
      const [
        name,
        variant,
      ] of Object.entries(
        result.variants
      )
    ) {
      console.log("");
      console.log(
        `${name}:`
      );

      console.log(
        `  Key: ${variant.key}`
      );

      console.log(
        `  Tamaño: ${(variant.bytes / 1024).toFixed(2)} KB`
      );
    }

    /* =====================================
       URL FIRMADA
    ===================================== */

    const cardUrl =
      await getProductImageSignedUrl(
        result.variants.card.key,
        {
          expiresIn: 300,
        }
      );

    console.log("");
    console.log(
      "URL temporal CARD:"
    );

    console.log(
      cardUrl
    );

    console.log("");
    console.log(
      "Abre esa URL en el navegador."
    );

    console.log("");
    console.log(
      "========================================="
    );

    console.log(
      "✅ TEST COMPLETADO"
    );

    console.log(
      "========================================="
    );

    /*
      IMPORTANTE:
      no eliminamos automáticamente,
      porque queremos verla en Railway
      y abrir la URL.
    */

    process.exit(0);
  } catch (error) {
    console.error("");
    console.error(
      "❌ ERROR:"
    );

    console.error(error);

    /*
      Solo limpiamos si el test falla
      parcialmente.
    */
    if (
      uploadedKeys.length >
      0
    ) {
      try {
        await deleteProductImageVariants(
          uploadedKeys
        );
      } catch {
        // Ignorar error de limpieza.
      }
    }

    process.exit(1);
  }
};

run();