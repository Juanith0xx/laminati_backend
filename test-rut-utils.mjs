import {
  calculateRutDv,
  formatRut,
  isValidRut,
  normalizeRut,
} from "./src/utils/rut.utils.js";


const cases = [
  {
    input: "76.376.809-0",
    expected: true,
  },
  {
    input: "763768090",
    expected: true,
  },
  {
    input: "76.123.456-7",
    expected: false,
  },
];


for (const testCase of cases) {
  const valid =
    isValidRut(
      testCase.input
    );

  if (
    valid !==
    testCase.expected
  ) {
    throw new Error(
      `Resultado incorrecto para ${testCase.input}`
    );
  }
}


const normalized =
  normalizeRut(
    "763768090"
  );

if (
  normalized.formatted !==
  "76.376.809-0"
) {
  throw new Error(
    "Normalización de RUT incorrecta"
  );
}


if (
  calculateRutDv(
    "76376809"
  ) !== "0"
) {
  throw new Error(
    "Cálculo de DV incorrecto"
  );
}


if (
  formatRut(
    "763768090"
  ) !==
  "76.376.809-0"
) {
  throw new Error(
    "Formateo de RUT incorrecto"
  );
}


console.log(
  "RUT utils OK"
);
