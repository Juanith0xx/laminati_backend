import "dotenv/config";

import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import {
  storageClient,
  STORAGE_BUCKET,
} from "../src/config/storage.js";

/* =========================================
   CONFIGURACIÓN TEST
========================================= */

const TEST_KEY = `tests/storage-test-${Date.now()}.txt`;

const TEST_CONTENT =
  "Laminatiword - Railway Storage funcionando correctamente";

/* =========================================
   TEST
========================================= */

const runTest = async () => {
  try {
    console.log("");
    console.log("=========================================");
    console.log("RAILWAY STORAGE TEST");
    console.log("=========================================");
    console.log("");

    console.log("Bucket:");
    console.log(STORAGE_BUCKET);

    console.log("");
    console.log("Object key:");
    console.log(TEST_KEY);

    /* =========================================
       1. SUBIR
    ========================================= */

    console.log("");
    console.log("1. Subiendo archivo...");

    await storageClient.send(
      new PutObjectCommand({
        Bucket: STORAGE_BUCKET,
        Key: TEST_KEY,
        Body: TEST_CONTENT,
        ContentType: "text/plain; charset=utf-8",
      })
    );

    console.log("✅ Archivo subido");

    /* =========================================
       2. LEER
    ========================================= */

    console.log("");
    console.log("2. Leyendo archivo...");

    const object = await storageClient.send(
      new GetObjectCommand({
        Bucket: STORAGE_BUCKET,
        Key: TEST_KEY,
      })
    );

    const content =
      await object.Body.transformToString();

    console.log("✅ Archivo leído");

    console.log("");
    console.log("Contenido:");
    console.log(content);

    if (content !== TEST_CONTENT) {
      throw new Error(
        "El contenido recuperado no coincide con el original"
      );
    }

    console.log("");
    console.log("✅ Contenido verificado");

    /* =========================================
       3. ELIMINAR
    ========================================= */

    console.log("");
    console.log("3. Eliminando archivo...");

    await storageClient.send(
      new DeleteObjectCommand({
        Bucket: STORAGE_BUCKET,
        Key: TEST_KEY,
      })
    );

    console.log("✅ Archivo eliminado");

    /* =========================================
       RESULTADO
    ========================================= */

    console.log("");
    console.log("=========================================");
    console.log("✅ RAILWAY STORAGE FUNCIONA CORRECTAMENTE");
    console.log("=========================================");
    console.log("");

    process.exit(0);
  } catch (error) {
    console.error("");
    console.error("=========================================");
    console.error("❌ ERROR RAILWAY STORAGE");
    console.error("=========================================");
    console.error("");

    console.error(error);

    /*
      Intentamos limpiar el archivo si alcanzó
      a ser subido antes de producirse el error.
    */
    try {
      await storageClient.send(
        new DeleteObjectCommand({
          Bucket: STORAGE_BUCKET,
          Key: TEST_KEY,
        })
      );
    } catch {
      // No hacemos nada.
    }

    process.exit(1);
  }
};

runTest();